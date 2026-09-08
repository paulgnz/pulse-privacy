import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PATHS, SHIELD, SHIELD_HOME } from "../config";
import { broadcast, describeLastError, deterministicSigner, getPublicBalance, hasBalanceRow, openBalanceAction } from "../lib/chain";
import type { Session } from "../lib/chain";
import type { Pt } from "../lib/crypto/babyjub";
import { eq } from "../lib/crypto/babyjub";
import { amountProblem, fmtUnits, parseUnits } from "../lib/format";
import { keygen, randScalar } from "../lib/shield/notes";
import { committeeCopy, openPhraseCopy, parseSecretInput, phraseCopy } from "../lib/shield/backup";
import type { OwnedNote, ShieldKeys } from "../lib/shield/notes";
import * as sh from "../lib/shield/chain";
import type { BackupRow, Prefetched, ShieldConfig } from "../lib/shield/chain";
import { unlockShield } from "../lib/unlock";
import type { Token } from "../lib/token";
import { ShieldActivity, ShieldAuditor, ShieldRecoveryStep, ShieldSettings } from "./ShieldPages";
import { Amount } from "./Amount";
import { AmountInput, Field, Line, Note, Progress, TokenIcon } from "./ui";

const SAVED = (actor: string) => `pulse-privacy/shield/${actor}`;
const BACKED = (actor: string) => `pulse-privacy/shield/${actor}/backedup`;
const SHIELD_TABS = [["statement", "Statement"], ["activity", "Activity"], ["auditor", "Auditor"], ["settings", "Settings"]] as const;
type ShieldTab = (typeof SHIELD_TABS)[number][0];
const REVEAL = "pulse-privacy/shield/reveal";

type Form = "send" | "deposit" | "withdraw" | null;

/**
 * Shielded mode (docs/06): notes instead of named boxes. Sending and withdrawing never open
 * the wallet; the relay permission submits the proof. Only deposits and the one-time
 * registration are wallet transactions.
 */
/** setup progress: "Step k of n", a filled track, and the step names. The list adapts to the
 *  wallet: the confirming signature only exists for wallets that sign differently each time,
 *  and registration only for accounts not yet on chain. */
const SetupProgress = ({ steps, current }: { steps: string[]; current: number }) => (
  <div className="progress" role="group" aria-label="Setup progress">
    <div className="progress-label">Step {current + 1} of {steps.length}<span className="muted"> · {steps[current]}</span></div>
    <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={current} aria-valuetext={`Step ${current + 1} of ${steps.length}: ${steps[current]}`}>
      <div className="progress-fill" style={{ width: `${(current / steps.length) * 100}%` }} />
    </div>
    <ol className="progress-steps">
      {steps.map((label, i) => <li key={label} className={i < current ? "done" : i === current ? "current" : ""}>{label}</li>)}
    </ol>
  </div>
);

export const Shielded = ({ session, onConnect, connectBusy, tokens }: { session: Session | null; onConnect: () => void; connectBusy: boolean; tokens: Token[] }) => {
  const actor = session?.auth.actor ?? "";
  const [keys, setKeys] = useState<ShieldKeys | null>(null);
  const [cfg, setCfg] = useState<ShieldConfig | null | undefined>(undefined);
  const [registered, setRegistered] = useState<Pt | null | undefined>(undefined);
  const [notes, setNotes] = useState<OwnedNote[] | null>(null);
  const [spent, setSpent] = useState<OwnedNote[]>([]);
  const [pub, setPub] = useState<Record<string, bigint>>({});
  const [form, setForm] = useState<Form>(null);
  const [tokenCode, setTokenCode] = useState<string>("XPR");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<{ f: number; s: string } | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string; txid?: string } | null>(null);
  const [revealed, setRevealed] = useState(() => { try { return localStorage.getItem(REVEAL) === "1"; } catch { return false; } });
  const [showSpent, setShowSpent] = useState(false);
  const [confirmed, setConfirmed] = useState(true);
  // read ahead when a form opens, so the click leads straight to the proof and the wallet
  const pre = useRef<Prefetched | null>(null);
  const seq = useRef(0);
  const [peers, setPeers] = useState<string[]>([]);
  const [unfinished, setUnfinished] = useState<{ id: number; amount: bigint; sym: string; r: string }[]>([]);
  const [firstAsk, setFirstAsk] = useState<bigint | null>(null);
  const [keyDerived, setKeyDerived] = useState(false);
  const [backup, setBackup] = useState<BackupRow | null | undefined>(undefined);
  const [pendingBackup, setPendingBackup] = useState<{ passphrase: string; committee: boolean } | null>(null);
  const [restoreSecret, setRestoreSecret] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [restoreWith, setRestoreWith] = useState<"phrase" | "file">("phrase");
  const [derivedMismatch, setDerivedMismatch] = useState(false);
  const [regUnknown, setRegUnknown] = useState(false);
  const [tab, setTab] = useState<ShieldTab>(() => { const t = new URLSearchParams(location.search).get("tab"); return SHIELD_TABS.some(([k]) => k === t) ? (t as ShieldTab) : "statement"; });

  const shieldTokens = useMemo(() => (cfg?.tokens ?? []).map((t) => t.token).sort((a, b) => (a.code === "XPR" ? -1 : b.code === "XPR" ? 1 : a.code.localeCompare(b.code))), [cfg]);
  const token = useMemo(() => shieldTokens.find((t) => t.code === tokenCode) ?? shieldTokens[0] ?? tokens[0], [shieldTokens, tokenCode, tokens]);
  const idOf = (code: string) => cfg?.tokens.find((t) => t.token.code === code)?.id ?? 0n;
  const balance = (code: string) => (notes ?? []).filter((n) => n.token === idOf(code)).reduce((s, n) => s + n.v, 0n);

  useEffect(() => { sh.getConfig(tokens).then(setCfg).catch(() => setCfg(null)); }, [tokens]);

  // A saved key exists only for wallets that cannot re-derive one (passkeys). Wallets with a
  // K1 key derive the spending key again each session with one signature, and it stays in memory:
  // the browser holding this key can spend shielded funds without any further prompt.
  useEffect(() => {
    seq.current += 1;
    const mine = seq.current;
    setKeys(null); setRegistered(undefined); setNotes(null); setSpent([]); setPub({}); setPeers([]); setShowSpent(false); setNotice(null); setForm(null); setStage(null);
    setFirstAsk(null); setKeyDerived(false); setBackup(undefined); setPendingBackup(null); setRestoreSecret(""); setRestorePass(""); setDerivedMismatch(false); setRegUnknown(false);
    pre.current = null;
    if (!actor) return;
    // a saved key from an earlier visit (passkey wallets, or a wallet that signs differently each time);
    // until its secret has been copied once, it is shown again and registration stays gated
    try {
      const saved = localStorage.getItem(SAVED(actor));
      if (saved) setKeys(keygen(BigInt(saved)));
    } catch { /* ignore */ }
    sh.registeredKey(actor).then((k) => { if (seq.current === mine) { setRegistered(k); setRegUnknown(false); } }).catch(() => { if (seq.current === mine) { setRegistered(undefined); setRegUnknown(true); } });
    sh.backupRow(actor).then((b) => { if (seq.current === mine) setBackup(b); }).catch(() => { if (seq.current === mine) setBackup(null); });
  }, [actor, session]);

  const refresh = useCallback(async () => {
    if (!keys) return;
    const mine = seq.current;
    const r = await sh.scan(keys);
    if (seq.current !== mine) return; // the account changed while reading
    setNotes(r.notes);
    setSpent(r.spent);
    setConfirmed(r.confirmed !== false);
    const p: Record<string, bigint> = {};
    for (const t of shieldTokens) p[t.code] = await getPublicBalance(actor, t).catch(() => 0n);
    const u = await sh.unfinishedDeposits(actor).catch(() => []);
    if (seq.current === mine) { setPub(p); setUnfinished(u); }
  }, [keys, actor, shieldTokens]);

  // a saved key that is not the registered one is useless for this account: set it aside and
  // go to the restore screen rather than scanning with it and showing an empty balance
  useEffect(() => {
    if (!keys || !registered || keyDerived || eq(keys.pk, registered)) return;
    try {
      const saved = localStorage.getItem(SAVED(actor));
      if (saved) { localStorage.setItem(`${SAVED(actor)}/mismatch-${Date.now()}`, saved); localStorage.removeItem(SAVED(actor)); }
    } catch { /* ignore */ }
    setKeys(null);
    setNotice({ ok: false, text: "The key saved in this browser is not the one registered for this account, so it was set aside. Restore the registered key from your recovery phrase or key file." });
  }, [keys, registered, keyDerived, actor]);
  useEffect(() => { if (keys && registered && eq(keys.pk, registered)) refresh().catch((e) => setNotice({ ok: false, text: (e as Error).message })); }, [keys, registered, refresh]);
  useEffect(() => {
    if (!keys || !registered) return;
    const h = setInterval(() => { if (document.visibilityState === "visible") refresh().catch(() => undefined); }, 30000);
    return () => clearInterval(h);
  }, [keys, registered, refresh]);

  // Key derivation always starts with a wallet signature. Wallets with a K1 key sign the same
  // message the same way every time, so one signature is enough. Other wallets sign a second
  // time from a second click; if the two agree the key is derived, if they differ (passkeys) a
  // generated key is kept in this browser instead, with its secret shown for saving.
  const adopt = (ask: bigint, save: boolean) => {
    const k = keygen(ask);
    if (registered && !eq(registered, k.pk)) {
      // a key saved in this browser from the registration is still valid
      try { const s = localStorage.getItem(SAVED(actor)); if (s && eq(keygen(BigInt(s)).pk, registered)) { setKeys(keygen(BigInt(s))); return; } } catch { /* ignore */ }
      setDerivedMismatch(true);
      throw new Error("This wallet derives a different key from the one registered for this account: the registration was made with a saved key, or with a different wallet key or permission. Restore the registered key from your recovery phrase or key file.");
    }
    if (save) { try { localStorage.setItem(SAVED(actor), ask.toString()); } catch { /* ignore */ } }
    setKeyDerived(!save);
    setKeys(k);
  };
  const unlock = async () => {
    if (!session) return;
    setBusy(true); setNotice(null);
    try {
      const ask = await unlockShield(session, SHIELD.contract);
      if (deterministicSigner(session) || registered) {
        adopt(ask, false); // a registered account: the chain says whether the key is right
      } else if (firstAsk === null) {
        setFirstAsk(ask); // ask for a second signature from a second click
      } else if (firstAsk === ask) {
        adopt(ask, false);
      } else {
        // signatures differ: this wallet cannot re-derive; keep a generated key in the browser
        const gen = randScalar();
        adopt(gen, true);
      }
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); }
  };

  /** a saved key arriving on a new device: from the key file, or from the phrase copy on chain */
  const adoptRestored = (ask: bigint) => {
    if (!registered) return;
    const k = keygen(ask);
    if (!eq(k.pk, registered)) throw new Error("That does not open to the key registered for this account.");
    try { localStorage.setItem(SAVED(actor), ask.toString()); localStorage.setItem(BACKED(actor), "1"); } catch { /* ignore */ }
    setRestoreSecret(""); setRestorePass("");
    setKeyDerived(false);
    setKeys(k);
  };
  const restoreFromFile = () => {
    setNotice(null);
    try { adoptRestored(parseSecretInput(restoreSecret)); } catch (e) { setNotice({ ok: false, text: (e as Error).message }); }
  };
  const restoreFromPhrase = async () => {
    if (!backup?.phrase) return;
    setBusy(true); setNotice(null);
    try { adoptRestored(await openPhraseCopy(backup.phrase, restorePass)); }
    catch (e) { setNotice({ ok: false, text: /passphrase/.test((e as Error).message) ? "Those words do not open the recovery copy. Check the order and spelling." : (e as Error).message }); }
    finally { setBusy(false); }
  };

  /** re-read the recovery row until the chain shows the change */
  const refreshBackup = async (changed: (b: BackupRow | null) => boolean) => {
    for (let i = 0; i < 12; i++) {
      const b = await sh.backupRow(actor).catch(() => undefined);
      if (b !== undefined && changed(b)) { setBackup(b); return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const savePhrase = async (passphrase: string) => {
    if (!session || !keys) return;
    const phrase = await phraseCopy(keys.ask, passphrase);
    await broadcast(session, [sh.setBackupAction(session, phrase, "")]); // empty keeps the committee copy on chain
    try { localStorage.setItem(BACKED(actor), "1"); } catch { /* ignore */ }
    await refreshBackup((b) => b?.phrase === phrase);
  };
  const keepCommittee = async () => {
    if (!session || !keys || !cfg) return;
    const committee = committeeCopy(keys.ask, cfg.auditorPk);
    await broadcast(session, [sh.setBackupAction(session, "", committee)]); // empty keeps the phrase copy on chain
    await refreshBackup((b) => b?.committee === committee);
  };

  const register = async () => {
    if (!session || !keys) return;
    setBusy(true); setNotice(null);
    try {
      const actions: unknown[] = [sh.registerAction(session, keys.pk)];
      let row: BackupRow | null = null;
      if (pendingBackup && cfg) {
        row = { phrase: await phraseCopy(keys.ask, pendingBackup.passphrase), committee: pendingBackup.committee ? committeeCopy(keys.ask, cfg.auditorPk) : "" };
        actions.push(sh.setBackupAction(session, row.phrase, row.committee));
      }
      await broadcast(session, actions);
      setRegistered(keys.pk);
      if (row) { setBackup(row); setPendingBackup(null); try { localStorage.setItem(BACKED(actor), "1"); } catch { /* ignore */ } }
      setNotice({ ok: true, text: row ? "Registered, with your recovery copies stored. Others can now pay you shielded." : "Registered. Others can now pay you shielded." });
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); }
  };

  /** re-read until the chain shows the change (the node may not have the block yet), up to ~12 s */
  const refreshUntil = async (changed: (r: sh.ScanResult) => boolean) => {
    const mine = seq.current;
    const k = keys!;
    for (let i = 0; i < 8; i++) {
      await new Promise((res) => setTimeout(res, i === 0 ? 1200 : 1500));
      if (seq.current !== mine) return; // signed out or switched account meanwhile
      try {
        const r = await sh.scan(k);
        if (seq.current !== mine) return;
        setNotes(r.notes); setSpent(r.spent);
        if (changed(r)) break;
      } catch { /* try again */ }
    }
    if (seq.current === mine) refresh().catch(() => undefined);
  };

  const run = async (label: string, f: (onProgress: (fr: number, s: string) => void) => Promise<{ txid: string }>) => {
    setBusy(true); setNotice(null); setStage({ f: 0, s: "Starting" });
    const before = { unspent: (notes ?? []).map((n) => n.index).join(","), count: (notes ?? []).length };
    try {
      const r = await f((fr, s) => setStage({ f: fr, s }));
      setNotice({ ok: true, text: label, txid: r.txid });
      setForm(null);
      setStage({ f: 1, s: "Confirming on chain" });
      await refreshUntil((res) => res.notes.map((n) => n.index).join(",") !== before.unspent || res.notes.length !== before.count);
    } catch (e) {
      const detail = describeLastError();
      const msg = (e as Error).message;
      setNotice({ ok: false, text: `Not done. ${msg}${detail && !msg.startsWith("Your browser blocked") ? ` Details: ${detail}` : ""}` });
    } finally { setBusy(false); setStage(null); pre.current = null; }
  };

  const toggleReveal = () => { setRevealed((r) => { try { localStorage.setItem(REVEAL, r ? "0" : "1"); } catch { /* ignore */ } return !r; }); };

  // ---------------------------------------------------------------- states

  if (!SHIELD.enabled) return <section className="statement"><h2>Private XPR</h2><p className="muted">Private XPR v2 is on the testnet site only for now.</p></section>;

  const intro = (
    <>
      <h2>Private XPR</h2>
      <p className="lede" style={{ marginBottom: 26 }}>A private payment hides who was paid and how much. The chain shows only that you paid someone. Your wallet signs every payment, as always, and only the XPR Network auditor's key opens the details. Deposits and withdrawals stay public.{SHIELD_HOME ? " Testnet, early access." : " Testnet only, early access."} <a href={PATHS.shieldedAbout}>How it works</a>.</p>
    </>
  );

  // the setup steps for this wallet and account
  const hasSaved = (() => { try { return !!localStorage.getItem(SAVED(actor)); } catch { return false; } })();
  const passkey = !!session && !deterministicSigner(session);
  // a passkey wallet cannot re-derive: the key lives where it was made, and moves only as a recovery copy
  const needsRestore = !!registered && !hasSaved && !keys && (passkey || derivedMismatch);
  const setupSteps = needsRestore
    ? ["Connect wallet", "Restore your key", "Ready"]
    : registered
      ? ["Connect wallet", "Unlock your key", "Ready"]
      : ["Connect wallet", "Create your key", ...(passkey ? ["Confirm your key", "Recovery phrase"] : []), "Register", "Ready"];
  const stepIndex = (label: string) => Math.max(0, setupSteps.indexOf(label));

  if (!session) {
    return (
      <section className="statement">
        {intro}
        <SetupProgress steps={["Connect wallet", "Create your key", "Register", "Ready"]} current={0} />
        <div className="row">
          <button className="btn private" onClick={onConnect} disabled={connectBusy}>{connectBusy ? "Connecting" : "Connect wallet"}</button>
        </div>
      </section>
    );
  }
  if (regUnknown) return <section className="statement">{intro}<Note level="error">Your registration could not be confirmed: fewer than two nodes agreed. Nothing is wrong with your account; try again in a moment.</Note><div className="row" style={{ marginTop: 14 }}><button className="btn secondary" onClick={() => { setRegUnknown(false); setRegistered(undefined); sh.registeredKey(actor).then((k) => { setRegistered(k); }).catch(() => setRegUnknown(true)); }}>Try again</button></div></section>;
  if (cfg === undefined || registered === undefined) return <section className="statement">{intro}<div className="empty">Checking the shielded contract</div></section>;
  if (cfg === null) return <section className="statement">{intro}<Note level="error">The shielded contract is not reachable right now.</Note></section>;

  if (!keys) {
    if (needsRestore) {
      return (
        <section className="statement">
          {intro}
          <SetupProgress steps={setupSteps} current={1} />
          <h3>Restore your shielded key on this device</h3>
          <p className="muted">Your wallet uses passkeys, which sign differently each time, so your shielded key is a saved key rather than one derived from a signature. It lives in the browser where you registered and comes to a new device only through a recovery copy.</p>
          {notice ? <Note level={notice.ok ? "ok" : "error"}>{notice.text}</Note> : null}
          {backup === undefined ? <div className="empty">Checking your recovery copies</div> : restoreWith === "phrase" && backup?.phrase ? (
            <>
              <Field label="Recovery phrase" hint="The seven words, or the passphrase you chose, from when you set up recovery.">
                <input type="password" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} autoComplete="current-password" autoFocus />
              </Field>
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn private" onClick={restoreFromPhrase} disabled={busy || !restorePass.trim()}>{busy ? "Restoring" : "Restore"}</button>
                <button className="textbtn quiet" onClick={() => setRestoreWith("file")}>I have the key file instead</button>
              </div>
            </>
          ) : (
            <>
              {!backup?.phrase ? <p className="small muted" style={{ marginBottom: 12 }}>{backup?.committee ? "No recovery phrase was set for this account. The XPR Network committee holds an encrypted copy of the key and can return it after you prove you own the account; otherwise use the key file." : "No recovery phrase and no committee copy were set for this account. Only the key file, or the browser where you registered, can restore the key."}</p> : null}
              <Field label="Key file, or the secret inside it" hint="Paste the contents of the key file downloaded from Settings on the device where you registered.">
                <textarea className="mono" rows={3} value={restoreSecret} onChange={(e) => setRestoreSecret(e.target.value)} placeholder="{ … } or 0x…" spellCheck={false} />
              </Field>
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn private" onClick={restoreFromFile} disabled={busy || !restoreSecret.trim()}>Restore</button>
                {backup?.phrase ? <button className="textbtn quiet" onClick={() => setRestoreWith("phrase")}>Use the recovery phrase instead</button> : null}
              </div>
            </>
          )}
          <p className="small muted" style={{ marginTop: 14 }}>The registration cannot be replaced: if no copy of the key exists anywhere, the notes under it cannot be read.</p>
        </section>
      );
    }
    return (
      <section className="statement">
        {intro}
        <SetupProgress steps={setupSteps} current={firstAsk !== null ? stepIndex("Confirm your key") : registered ? stepIndex("Unlock your key") : stepIndex("Create your key")} />
        <h3>{registered ? `Unlock shielded payments for ${actor}` : `Set up shielded payments for ${actor}`}</h3>
        {!passkey ? (
          <p className="muted">One signature derives your shielded key from your wallet. Nothing is sent to the chain by that signature, and the same wallet derives the same key on any device. The key reads your notes and builds proofs; moving anything still needs your wallet's signature.</p>
        ) : hasSaved ? (
          <p className="muted">Your shielded key is saved in this browser. One wallet signature confirms it is you and unlocks it. The key reads your notes and builds proofs; moving anything still needs your wallet's signature.</p>
        ) : (
          <p className="muted">Two signatures from your wallet show whether it can derive a shielded key. Wallets with a standard key sign the same way every time, and derive the same key on any device. Passkey wallets sign differently each time, so this browser keeps a generated key instead, with a recovery phrase you write down next. Nothing is sent to the chain by these signatures.</p>
        )}
        {notice ? <Note level={notice.ok ? "ok" : "error"}>{notice.text}</Note> : null}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn private" onClick={unlock} disabled={busy}>{busy ? "Waiting for your wallet" : firstAsk !== null ? "Sign again to confirm" : registered ? "Sign to unlock" : "Sign to create your key"}</button>
        </div>
        {firstAsk !== null ? <p className="small muted" style={{ marginTop: 10 }}>Once more: two matching signatures prove this wallet can re-derive the key on any device.</p> : null}
      </section>
    );
  }
  if (!registered) {
    if (!keyDerived && !pendingBackup) {
      return (
        <section className="statement">
          {intro}
          <SetupProgress steps={setupSteps} current={stepIndex("Recovery phrase")} />
          <ShieldRecoveryStep actor={actor} ask={keys.ask} onContinue={(passphrase, committee) => { setPendingBackup({ passphrase, committee }); }} />
        </section>
      );
    }
    return (
      <section className="statement">
        {intro}
        <SetupProgress steps={setupSteps} current={stepIndex("Register")} />
        <h3>Register your shielded key</h3>
        <p className="muted">Publishes the public half of your key under your account name, so people can pay you by name. One wallet signature; it is the only time your account and this key appear together.{pendingBackup ? ` The same transaction stores your recovery copies: the phrase copy${pendingBackup.committee ? " and the committee copy" : ""}.` : ""}</p>
        {notice ? <Note level={notice.ok ? "ok" : "error"}>{notice.text}</Note> : null}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn private" onClick={register} disabled={busy}>{busy ? "Waiting for your wallet" : "Register"}</button>
          {pendingBackup ? <button className="textbtn quiet" onClick={() => setPendingBackup(null)} disabled={busy}>Back</button> : null}
        </div>
      </section>
    );
  }

  // ---------------------------------------------------------------- statement

  const tokenOf = (id: bigint) => cfg.tokens.find((t) => t.id === id)?.token ?? token;
  const toggle = (f: Form) => {
    setForm((cur) => (cur === f ? null : f));
    if (f !== "deposit") {
      sh.prefetch(keys).then((p) => { pre.current = p; }).catch(() => undefined);
      sh.registeredNames().then((n) => setPeers(n.filter((x) => x !== actor))).catch(() => undefined);
    }
  };
  const parsedAmount = (s: string): bigint | null => { try { return s ? parseUnits(s, token) : null; } catch { return null; } };

  const nav = (
    <nav className="nav" aria-label="Sections">
      {SHIELD_TABS.map(([k, label]) => (
        <a key={k} href={`?tab=${k}`} onClick={(e) => { e.preventDefault(); setTab(k); }} aria-current={k === tab ? "page" : undefined}>{label}</a>
      ))}
    </nav>
  );
  const fileSaved = (() => { try { return localStorage.getItem(BACKED(actor)) === "1"; } catch { return false; } })();
  const forget = () => {
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(`pulse-privacy/shield/${actor}`)) localStorage.removeItem(k); } catch { /* ignore */ }
    setKeys(null); setNotes(null); setSpent([]); setFirstAsk(null); setKeyDerived(false); setPendingBackup(null); setTab("statement");
  };
  if (tab === "settings") return <>{nav}<section className="statement" aria-label="Shielded settings"><ShieldSettings actor={actor} keys={keys} registered={registered} derived={keyDerived} backup={backup} busy={busy} onSavePhrase={async (p) => { setBusy(true); try { await savePhrase(p); } finally { setBusy(false); } }} onKeepCommittee={async () => { setBusy(true); try { await keepCommittee(); } finally { setBusy(false); } }} onForget={forget} /></section></>;
  if (tab === "activity") return <>{nav}<section className="statement" aria-label="Shielded activity"><ShieldActivity cfg={cfg} keys={keys} actor={actor} notes={notes} spent={spent} token={token} revealed={revealed} onReveal={toggleReveal} /></section></>;
  if (tab === "auditor") return <>{nav}<section className="statement" aria-label="Shielded auditor"><ShieldAuditor cfg={cfg} token={token} /></section></>;

  return (
    <>
    {nav}
    <section className="statement" aria-label="Shielded statement">
      {intro}
      {notice ? (
        <Note level={notice.ok ? "ok" : "error"}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
            <span>
              {notice.text}
              {notice.txid ? <> <a href={sh.txLink(notice.txid)} target="_blank" rel="noreferrer">Transaction {notice.txid.slice(0, 12)}</a>.</> : null}
            </span>
            <button className="textbtn quiet" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        </Note>
      ) : null}

      {unfinished.length ? (
        <Note level="warn">
          <p>{unfinished.length === 1 ? "A deposit arrived but was never placed in your notes." : `${unfinished.length} deposits arrived but were never placed in your notes.`} Finishing takes one wallet signature and pays the small storage cost.</p>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn secondary" disabled={busy} onClick={() => run("Deposit placed in your notes.", async () => { const txid = await broadcast(session, unfinished.map((u) => sh.finishDepositAction(session, u.r))); return { txid }; })}>{busy ? "Working" : "Finish"}</button>
          </div>
        </Note>
      ) : null}
      {!confirmed ? <Note level="warn">Only one node answered, so this balance is unconfirmed. Wait for a second node before acting on it.</Note> : null}
      {!keyDerived && backup !== undefined && !backup?.phrase && !backup?.committee && !fileSaved ? (
        <Note level="warn">
          <p>Recovery is not set up. Your shielded key is saved in this browser only: without a recovery copy, a lost or cleared browser means these notes are gone.</p>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn secondary" onClick={() => setTab("settings")}>Set up recovery</button>
          </div>
        </Note>
      ) : null}
      <div className="group private">
        <h3>
          Private balance
          <span className="sub">{revealed ? "Shown on this device only. The chain holds sealed notes." : "Hidden by default. Reveal shows it on this device only."}</span>
        </h3>
        <button className="textbtn" onClick={toggleReveal} aria-pressed={revealed}>{revealed ? "Hide" : "Reveal"}</button>
      </div>
      {shieldTokens.map((t) => (
        <Line key={t.code} label={<span className="tok"><TokenIcon code={t.code} />{t.code}</span>} hero>
          {notes === null ? <span className="muted">Reading your notes</span> : <Amount value={balance(t.code)} hidden revealed={revealed} size="big" digits={7} token={t} unit={false} />}
        </Line>
      ))}

      <div className="actions" role="group" aria-label="Actions">
        <button className="btn" onClick={() => toggle("send")} aria-expanded={form === "send"}>Send</button>
        <button className="btn secondary" onClick={() => toggle("deposit")} aria-expanded={form === "deposit"}>Deposit</button>
        <button className="btn secondary" onClick={() => toggle("withdraw")} aria-expanded={form === "withdraw"}>Withdraw</button>
      </div>

      {form === "send" ? (
        <SendForm token={token} tokens={shieldTokens} onSelectToken={setTokenCode} spendable={balance(token.code)} busy={busy} stage={stage} parsed={parsedAmount} onClose={() => setForm(null)}
          peers={peers}
          onSend={(to, amount) => run(`Sent ${fmtUnits(amount, token)} ${token.code} to ${to}. The chain shows that you paid, not whom or how much.`, async (p) => { const prep = await sh.prepareSend(session, keys, cfg, token, to, amount, p, pre.current); const txid = await broadcast(session, [prep.action]); sh.rememberSend(actor, txid, to); p(1, "Done"); return { txid }; })} />
      ) : null}
      {form === "deposit" ? (
        <DepositForm token={token} tokens={shieldTokens} onSelectToken={setTokenCode} publicBalance={pub[token.code] ?? null} busy={busy} parsed={parsedAmount} onClose={() => setForm(null)}
          onDeposit={(amount) => run(`Deposited ${fmtUnits(amount, token)} ${token.code} into a private note.`, async () => { const slot = await sh.depositSlot(actor); if (slot && slot.amount > 0n) throw new Error("A deposit is still waiting to be placed. Finish it first."); const { actions } = sh.depositActions(session, cfg, token, keys.pk, amount, !!slot); const txid = await broadcast(session, actions); return { txid }; })} />
      ) : null}
      {form === "withdraw" ? (
        <WithdrawForm token={token} tokens={shieldTokens} onSelectToken={setTokenCode} spendable={balance(token.code)} busy={busy} stage={stage} parsed={parsedAmount} onClose={() => setForm(null)} actor={actor}
          onWithdraw={(amount) => run(`Withdrew ${fmtUnits(amount, token)} ${token.code} to ${actor}.`, async (p) => { const prep = await sh.prepareWithdraw(session, keys, cfg, token, amount, p, pre.current); const hasRow = await hasBalanceRow(actor, token).catch(() => true); const txid = await broadcast(session, [...(hasRow ? [] : [openBalanceAction(session, token)]), prep.action]); p(1, "Done"); return { txid }; })} />
      ) : null}

      <div className="group public">
        <h3>
          Wallet balance
          <span className="sub">Public. Anyone can read it.</span>
        </h3>
      </div>
      {shieldTokens.map((t) => (
        <Line key={t.code} label={<span className="tok"><TokenIcon code={t.code} />{t.code}</span>}>
          {pub[t.code] === undefined ? <span className="muted">Loading</span> : <Amount value={pub[t.code]} size="mid" token={t} unit={false} />}
        </Line>
      ))}

      <div className="group private" style={{ marginTop: 36 }}>
        <h3>
          Your notes
          <span className="sub">Each payment you received or kept as change is a sealed note. Nobody else can list these or read the amounts.</span>
        </h3>
        {spent.length ? <button className="textbtn quiet" onClick={() => setShowSpent((s) => !s)}>{showSpent ? "Hide spent" : `Show ${spent.length} spent`}</button> : null}
      </div>
      {notes && notes.length === 0 && !showSpent ? <p className="muted" style={{ marginTop: 12 }}>No notes yet. Deposit to create your first one, or ask someone to pay you.</p> : null}
      {[...(notes ?? []), ...(showSpent ? spent : [])].sort((a, b) => b.index - a.index).map((n) => (
        <Line key={n.index} label={<span className="tok"><TokenIcon code={tokenOf(n.token).code} />Note {n.index}</span>} sub={spent.includes(n) ? "spent" : "unspent"}>
          <Amount value={n.v} hidden revealed={revealed} size="mid" digits={5} token={tokenOf(n.token)} />
        </Line>
      ))}
    </section>
    </>
  );
};

// ---------------------------------------------------------------- forms

const SendForm = ({ token, tokens, onSelectToken, spendable, busy, stage, parsed, onClose, onSend, peers }: {
  token: Token; tokens: Token[]; onSelectToken: (c: string) => void; spendable: bigint; busy: boolean; stage: { f: number; s: string } | null;
  parsed: (s: string) => bigint | null; onClose: () => void; onSend: (to: string, amount: bigint) => void; peers: string[];
}) => {
  const [to, setTo] = useState(() => { const q = (new URLSearchParams(location.search).get("to") ?? "").trim().toLowerCase(); return /^[a-z1-5.]{1,12}$/.test(q) ? q : ""; });
  const [amt, setAmt] = useState("");
  const amount = parsed(amt);
  const problem = amt ? amountProblem(amt, token) : null;
  const over = amount !== null && amount > spendable;
  // is the recipient set up? known from the list, or looked up as they type
  const [known, setKnown] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const name = to.trim();
    if (!/^[a-z1-5.]{4,12}$/.test(name) || peers.includes(name) || name in known) return;
    const h = setTimeout(() => { sh.registeredKey(name).then((k) => setKnown((m) => ({ ...m, [name]: !!k }))).catch(() => undefined); }, 400);
    return () => clearTimeout(h);
  }, [to, peers, known]);
  const ready = peers.includes(to) || known[to] === true;
  const [fp, setFp] = useState<string>("");
  useEffect(() => { if (!ready) { setFp(""); return; } sh.registeredKeys().then((m) => { const k = m.get(to); setFp(k ? sh.keyFingerprint(k) : ""); }).catch(() => setFp("")); }, [to, ready]);
  const missing = /^[a-z1-5.]{4,12}$/.test(to) && known[to] === false && !peers.includes(to);
  const can = !!amount && amount > 0n && !over && !problem && ready && !busy;
  return (
    <div className="form" aria-label="Send shielded">
      <h3>Send</h3>
      <p className="muted">The chain will record that you spent notes and created two sealed ones. Not the receiver, not the amount. Your wallet signs it after the proof is built.</p>
      <Field label="To" hint={ready ? `${to} has set up shielded payments${fp ? ` (key ${fp})` : ""}.` : peers.length ? `${peers.length} account${peers.length === 1 ? " has" : "s have"} set up shielded payments; start typing to pick one.` : "An XPR account name that has set up shielded payments."} error={missing ? `${to} has not set up shielded payments yet.` : undefined}>
        <input value={to} onChange={(e) => setTo(e.target.value.trim().toLowerCase())} placeholder="account" autoComplete="off" list="shield-peers" autoFocus />
        <datalist id="shield-peers">
          {peers.map((p) => <option key={p} value={p} />)}
        </datalist>
      </Field>
      <Field label="Amount" hint={`${fmtUnits(spendable, token)} ${token.code} is in your shielded notes.`} error={problem ?? (over ? "More than your shielded balance." : undefined)}>
        <AmountInput value={amt} onChange={setAmt} token={token} tokens={tokens} onSelectToken={onSelectToken} />
      </Field>
      <div className="row" style={{ marginBottom: 6 }}>
        <button className="textbtn" onClick={() => setAmt(fmtUnits(spendable, token, { trim: true }))} disabled={spendable === 0n}>Max</button>
      </div>
      {stage ? <Progress fraction={stage.f} stage={stage.s} /> : null}
      <div className="row">
        <button className="btn private" onClick={() => amount && onSend(to, amount)} disabled={!can}>{busy ? "Working" : amount ? `Send ${fmtUnits(amount, token)} ${token.code}` : "Send"}</button>
        <button className="textbtn quiet" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
};

const DepositForm = ({ token, tokens, onSelectToken, publicBalance, busy, parsed, onClose, onDeposit }: {
  token: Token; tokens: Token[]; onSelectToken: (c: string) => void; publicBalance: bigint | null; busy: boolean;
  parsed: (s: string) => bigint | null; onClose: () => void; onDeposit: (amount: bigint) => void;
}) => {
  const [amt, setAmt] = useState("");
  const amount = parsed(amt);
  const problem = amt ? amountProblem(amt, token) : null;
  const over = amount !== null && publicBalance !== null && amount > publicBalance;
  const can = !!amount && amount > 0n && !over && !problem && !busy;
  return (
    <div className="form" aria-label="Deposit">
      <h3>Deposit</h3>
      <p className="muted">Moves public {token.code} from your wallet into a sealed note. The deposit itself is public: anyone can see you put this amount in. Your wallet signs it.</p>
      <Field label="Amount" hint={publicBalance === null ? undefined : `${fmtUnits(publicBalance, token)} ${token.code} in your wallet.`} error={problem ?? (over ? "More than your wallet holds." : undefined)}>
        <AmountInput value={amt} onChange={setAmt} token={token} tokens={tokens} onSelectToken={onSelectToken} />
      </Field>
      <div className="row">
        <button className="btn private" onClick={() => amount && onDeposit(amount)} disabled={!can}>{busy ? "Waiting for your wallet" : amount ? `Deposit ${fmtUnits(amount, token)} ${token.code}` : "Deposit"}</button>
        <button className="textbtn quiet" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
};

const WithdrawForm = ({ token, tokens, onSelectToken, spendable, busy, stage, parsed, onClose, onWithdraw, actor }: {
  token: Token; tokens: Token[]; onSelectToken: (c: string) => void; spendable: bigint; busy: boolean; stage: { f: number; s: string } | null;
  parsed: (s: string) => bigint | null; onClose: () => void; onWithdraw: (amount: bigint) => void; actor: string;
}) => {
  const [amt, setAmt] = useState("");
  const amount = parsed(amt);
  const problem = amt ? amountProblem(amt, token) : null;
  const over = amount !== null && amount > spendable;
  const can = !!amount && amount > 0n && !over && !problem && !busy;
  return (
    <div className="form" aria-label="Withdraw">
      <h3>Withdraw</h3>
      <p className="muted">Pays public {token.code} to {actor} from your notes. The chain sees that you withdrew this amount to your own account; it does not see which notes. Your wallet signs it after the proof is built.</p>
      <Field label="Amount" hint={`${fmtUnits(spendable, token)} ${token.code} is in your shielded notes.`} error={problem ?? (over ? "More than your shielded balance." : undefined)}>
        <AmountInput value={amt} onChange={setAmt} token={token} tokens={tokens} onSelectToken={onSelectToken} />
      </Field>
      <div className="row" style={{ marginBottom: 6 }}>
        <button className="textbtn" onClick={() => setAmt(fmtUnits(spendable, token, { trim: true }))} disabled={spendable === 0n}>Max</button>
      </div>
      {stage ? <Progress fraction={stage.f} stage={stage.s} /> : null}
      <div className="row">
        <button className="btn private" onClick={() => amount && onWithdraw(amount)} disabled={!can}>{busy ? "Working" : amount ? `Withdraw ${fmtUnits(amount, token)} ${token.code}` : "Withdraw"}</button>
        <button className="textbtn quiet" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
};
