import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SHIELD } from "../config";
import { broadcast, describeLastError, deterministicSigner, getPublicBalance } from "../lib/chain";
import type { Session } from "../lib/chain";
import type { Pt } from "../lib/crypto/babyjub";
import { eq } from "../lib/crypto/babyjub";
import { amountProblem, fmtUnits, parseUnits } from "../lib/format";
import { keygen, randScalar } from "../lib/shield/notes";
import type { OwnedNote, ShieldKeys } from "../lib/shield/notes";
import * as sh from "../lib/shield/chain";
import type { Prefetched, ShieldConfig } from "../lib/shield/chain";
import { unlockShield } from "../lib/unlock";
import type { Token } from "../lib/token";
import { Amount } from "./Amount";
import { AmountInput, Field, Line, Note, Progress, TokenIcon } from "./ui";

const SAVED = (actor: string) => `pulse-privacy/shield/${actor}`;
const REVEAL = "pulse-privacy/shield/reveal";

type Form = "send" | "deposit" | "withdraw" | null;

/**
 * Shielded mode (docs/06): notes instead of named boxes. Sending and withdrawing never open
 * the wallet; the relay permission submits the proof. Only deposits and the one-time
 * registration are wallet transactions.
 */
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
  // read ahead when a form opens, so the click leads straight to the proof and the wallet
  const pre = useRef<Prefetched | null>(null);
  const [peers, setPeers] = useState<string[]>([]);

  const shieldTokens = useMemo(() => (cfg?.tokens ?? []).map((t) => t.token).sort((a, b) => (a.code === "XPR" ? -1 : b.code === "XPR" ? 1 : a.code.localeCompare(b.code))), [cfg]);
  const token = useMemo(() => shieldTokens.find((t) => t.code === tokenCode) ?? shieldTokens[0] ?? tokens[0], [shieldTokens, tokenCode, tokens]);
  const idOf = (code: string) => cfg?.tokens.find((t) => t.token.code === code)?.id ?? 0n;
  const balance = (code: string) => (notes ?? []).filter((n) => n.token === idOf(code)).reduce((s, n) => s + n.v, 0n);

  useEffect(() => { sh.getConfig(tokens).then(setCfg).catch(() => setCfg(null)); }, [tokens]);

  // A saved key exists only for wallets that cannot re-derive one (passkeys). Wallets with a
  // K1 key derive the spending key again each session with one signature, and it stays in memory:
  // the browser holding this key can spend shielded funds without any further prompt.
  useEffect(() => {
    setKeys(null); setRegistered(undefined); setNotes(null); setNotice(null); setForm(null);
    if (!actor) return;
    if (session && !deterministicSigner(session)) {
      try {
        const saved = localStorage.getItem(SAVED(actor));
        if (saved) setKeys(keygen(BigInt(saved)));
      } catch { /* ignore */ }
    }
    sh.registeredKey(actor).then(setRegistered).catch(() => setRegistered(null));
  }, [actor, session]);

  const refresh = useCallback(async () => {
    if (!keys) return;
    const r = await sh.scan(keys);
    setNotes(r.notes);
    setSpent(r.spent);
    const p: Record<string, bigint> = {};
    for (const t of shieldTokens) p[t.code] = await getPublicBalance(actor, t).catch(() => 0n);
    setPub(p);
  }, [keys, actor, shieldTokens]);

  useEffect(() => { if (keys && registered) refresh().catch((e) => setNotice({ ok: false, text: (e as Error).message })); }, [keys, registered, refresh]);
  useEffect(() => {
    if (!keys || !registered) return;
    const h = setInterval(() => { if (document.visibilityState === "visible") refresh().catch(() => undefined); }, 30000);
    return () => clearInterval(h);
  }, [keys, registered, refresh]);

  const unlock = async () => {
    if (!session) return;
    setBusy(true); setNotice(null);
    try {
      let ask: bigint;
      const derivable = deterministicSigner(session);
      if (derivable) {
        ask = await unlockShield(session, SHIELD.contract);
      } else {
        // passkey wallets sign differently each time: keep a generated key in this browser
        const saved = localStorage.getItem(SAVED(actor));
        ask = saved ? BigInt(saved) : randScalar();
      }
      const k = keygen(ask);
      if (registered && !eq(registered, k.pk)) throw new Error("This wallet derives a different key from the one registered for this account. If you registered from another device with a saved key, import it there or contact the operator.");
      if (!derivable) { try { localStorage.setItem(SAVED(actor), ask.toString()); } catch { /* ignore */ } }
      setKeys(k);
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); }
  };

  const register = async () => {
    if (!session || !keys) return;
    setBusy(true); setNotice(null);
    try {
      await broadcast(session, [sh.registerAction(session, keys.pk)]);
      setRegistered(keys.pk);
      setNotice({ ok: true, text: "Registered. Others can now pay you shielded." });
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); }
  };

  /** re-read until the chain shows the change (the node may not have the block yet), up to ~12 s */
  const refreshUntil = async (changed: (r: sh.ScanResult) => boolean) => {
    for (let i = 0; i < 8; i++) {
      await new Promise((res) => setTimeout(res, i === 0 ? 1200 : 1500));
      try {
        const r = await sh.scan(keys!);
        setNotes(r.notes); setSpent(r.spent);
        if (changed(r)) break;
      } catch { /* try again */ }
    }
    refresh().catch(() => undefined);
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

  if (!SHIELD.enabled) return <section className="statement"><h2>Shielded</h2><p className="muted">Shielded payments are on the testnet site only for now.</p></section>;

  const intro = (
    <>
      <h2>Shielded</h2>
      <p className="lede" style={{ marginBottom: 26 }}>A shielded payment hides who was paid and how much. The chain shows only that you paid someone. Your wallet signs every payment, as always, and only the XPR Network auditor's key opens the details. Deposits and withdrawals stay public. Testnet only, early access.</p>
    </>
  );

  if (!session) {
    return (
      <section className="statement">
        {intro}
        <div className="row">
          <button className="btn private" onClick={onConnect} disabled={connectBusy}>{connectBusy ? "Connecting" : "Connect wallet"}</button>
        </div>
      </section>
    );
  }
  if (cfg === undefined || registered === undefined) return <section className="statement">{intro}<div className="empty">Checking the shielded contract</div></section>;
  if (cfg === null) return <section className="statement">{intro}<Note level="error">The shielded contract is not reachable right now.</Note></section>;

  if (!keys) {
    return (
      <section className="statement">
        {intro}
        <h3>Set up shielded payments for {actor}</h3>
        <p className="muted">One signature derives your shielded key from your wallet. Nothing is sent to the chain by that signature, and the same wallet derives the same key on any device. The key reads your notes and builds proofs; moving anything still needs your wallet's signature.</p>
        {notice ? <Note level={notice.ok ? "ok" : "error"}>{notice.text}</Note> : null}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn private" onClick={unlock} disabled={busy}>{busy ? "Waiting for your wallet" : registered ? "Sign to unlock" : "Sign to create your key"}</button>
        </div>
      </section>
    );
  }
  if (!registered) {
    return (
      <section className="statement">
        {intro}
        <h3>Register your shielded key</h3>
        <p className="muted">Publishes the public half of your key under your account name, so people can pay you by name. One wallet signature; it is the only time your account and this key appear together.</p>
        {notice ? <Note level={notice.ok ? "ok" : "error"}>{notice.text}</Note> : null}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn private" onClick={register} disabled={busy}>{busy ? "Waiting for your wallet" : "Register"}</button>
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

  return (
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

      <div className="group private">
        <h3>
          Shielded balance
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
          onSend={(to, amount) => run(`Sent ${fmtUnits(amount, token)} ${token.code} to ${to}. The chain shows that you paid, not whom or how much.`, async (p) => { const prep = await sh.prepareSend(session, keys, cfg, token, to, amount, p, pre.current); const txid = await broadcast(session, [prep.action]); p(1, "Done"); return { txid }; })} />
      ) : null}
      {form === "deposit" ? (
        <DepositForm token={token} tokens={shieldTokens} onSelectToken={setTokenCode} publicBalance={pub[token.code] ?? null} busy={busy} parsed={parsedAmount} onClose={() => setForm(null)}
          onDeposit={(amount) => run(`Deposited ${fmtUnits(amount, token)} ${token.code} into a shielded note.`, async () => { const { action } = sh.depositAction(session, cfg, token, keys.pk, amount); const txid = await broadcast(session, [action]); return { txid }; })} />
      ) : null}
      {form === "withdraw" ? (
        <WithdrawForm token={token} tokens={shieldTokens} onSelectToken={setTokenCode} spendable={balance(token.code)} busy={busy} stage={stage} parsed={parsedAmount} onClose={() => setForm(null)} actor={actor}
          onWithdraw={(amount) => run(`Withdrew ${fmtUnits(amount, token)} ${token.code} to ${actor}.`, async (p) => { const prep = await sh.prepareWithdraw(session, keys, cfg, token, amount, p, pre.current); const txid = await broadcast(session, [prep.action]); p(1, "Done"); return { txid }; })} />
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
  const missing = /^[a-z1-5.]{4,12}$/.test(to) && known[to] === false && !peers.includes(to);
  const can = !!amount && amount > 0n && !over && !problem && ready && !busy;
  return (
    <div className="form" aria-label="Send shielded">
      <h3>Send</h3>
      <p className="muted">The chain will record that you spent notes and created two sealed ones. Not the receiver, not the amount. Your wallet signs it after the proof is built.</p>
      <Field label="To" hint={ready ? `${to} has set up shielded payments.` : peers.length ? `${peers.length} account${peers.length === 1 ? " has" : "s have"} set up shielded payments; start typing to pick one.` : "An XPR account name that has set up shielded payments."} error={missing ? `${to} has not set up shielded payments yet.` : undefined}>
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
