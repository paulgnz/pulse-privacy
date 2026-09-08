import { useEffect, useMemo, useState } from "react";
import { EXPLORER, PATHS, SHIELD } from "../config";
import type { Pt } from "../lib/crypto/babyjub";
import { fmtUnits } from "../lib/format";
import * as sh from "../lib/shield/chain";
import type { ActivityEvent, BackupRow, ShieldConfig, ShieldEdges, ShieldLedgerRow } from "../lib/shield/chain";
import { shieldKeyFile } from "../lib/shield/backup";
import { MIN_PASSPHRASE, generatePassphrase, passphraseProblem } from "../lib/keys";
import type { OwnedNote, ShieldKeys } from "../lib/shield/notes";
import { keygen } from "../lib/shield/notes";
import type { Token } from "../lib/token";
import { Amount } from "./Amount";
import { Field, Note, TokenIcon } from "./ui";

const tokenOf = (cfg: ShieldConfig, id: bigint, fallback: Token) => cfg.tokens.find((t) => t.id === id)?.token ?? fallback;

// ---------------------------------------------------------------- recovery

const BACKED = (actor: string) => `pulse-privacy/shield/${actor}/backedup`;
export const isFileSaved = (actor: string) => { try { return localStorage.getItem(BACKED(actor)) === "1"; } catch { return false; } };
export const markFileSaved = (actor: string) => { try { localStorage.setItem(BACKED(actor), "1"); } catch { /* ignore */ } };

export function downloadKeyFile(actor: string, ask: bigint) {
  const blob = new Blob([shieldKeyFile(actor, ask)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `xpr-shielded-key-${actor}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  markFileSaved(actor);
}

/** the phrase chooser: generated seven words (copy before saving) or the user's own passphrase */
const PhraseInput = ({ pass, setPass, custom, setCustom, copied, setCopied, replacing }: {
  pass: string; setPass: (p: string) => void; custom: boolean; setCustom: (c: boolean) => void; copied: boolean; setCopied: (c: boolean) => void; replacing?: boolean;
}) => {
  const copy = async () => { try { await navigator.clipboard.writeText(pass); setCopied(true); } catch { /* selectable */ } };
  return custom ? (
    <Field className="wide" label="Your own passphrase" hint={`At least ${MIN_PASSPHRASE} characters, several words. The encrypted copy is public, so a short or common passphrase can be guessed offline.`} error={pass ? passphraseProblem(pass) ?? undefined : undefined}>
      <input type="text" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" placeholder="four or more words you will remember" />
      <p className="small" style={{ margin: "8px 0 0" }}><button className="textbtn quiet" onClick={() => { setCustom(false); setPass(generatePassphrase()); setCopied(false); }}>Use generated words instead</button></p>
    </Field>
  ) : (
    <>
      <p className="small muted" style={{ margin: "0 0 10px" }}>{replacing ? "Copy the new words before you save. Saving replaces the phrase you have now, and the old one stops working." : "Copy the words before you save. An encrypted copy of the key goes on chain; only these words open it, and they are not stored anywhere."}</p>
      <div className="secret words" aria-label="Your recovery phrase"><code>{pass}</code></div>
      <div className="row" style={{ margin: "12px 0 14px" }}>
        <button className="btn secondary" onClick={copy}>{copied ? "Copied" : "Copy phrase"}</button>
        <button className="textbtn quiet" onClick={() => { setPass(generatePassphrase()); setCopied(false); }}>New words</button>
        <button className="textbtn quiet" onClick={() => { setCustom(true); setPass(""); setCopied(false); }}>Type my own</button>
      </div>
    </>
  );
};

/** onboarding, saved keys only: write down the phrase, optionally the file, choose the committee copy */
export const ShieldRecoveryStep = ({ actor, ask, onContinue }: { actor: string; ask: bigint; onContinue: (passphrase: string, committee: boolean) => void }) => {
  const [pass, setPass] = useState(() => generatePassphrase());
  const [custom, setCustom] = useState(false);
  const [copied, setCopied] = useState(false);
  const [committee, setCommittee] = useState(true);
  const [written, setWritten] = useState(false);
  const [fileSaved, setFileSaved] = useState(() => isFileSaved(actor));
  const ok = custom ? !passphraseProblem(pass) : copied;
  return (
    <>
      <h3>Write down your recovery phrase</h3>
      <p className="muted">Your wallet signs with a passkey, so this app keeps a saved key for you. These seven words restore that key on any device. Copy them and keep them where you keep important things; without them, or the key file below, a lost device means locked notes until the committee helps.</p>
      <PhraseInput pass={pass} setPass={setPass} custom={custom} setCustom={setCustom} copied={copied} setCopied={setCopied} />
      <details className="explain" style={{ marginBottom: 18 }}>
        <summary>Also save the key file (optional)</summary>
        <div className="body">
          <p>The raw key as a file, for people who prefer one. The recovery phrase above restores the same key. Keep it private: anyone with it can read your notes.</p>
          <div className="row" style={{ margin: "10px 0 6px" }}>
            <button className="btn secondary" onClick={() => { downloadKeyFile(actor, ask); setFileSaved(true); }}>{fileSaved ? "Downloaded" : "Download key file"}</button>
          </div>
        </div>
      </details>
      <label className="check">
        <input type="checkbox" checked={committee} onChange={(e) => setCommittee(e.target.checked)} />
        <span>Keep an encrypted recovery copy with the XPR Network committee (recommended). Stored on chain with your registration; only the committee's key can open it, and spending still needs your wallet.</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={written} onChange={(e) => setWritten(e.target.checked)} />
        <span>I have written down my recovery phrase (or saved the key file) somewhere safe.</span>
      </label>
      <div className="row">
        <button className="btn private" onClick={() => onContinue(pass, committee)} disabled={!written || !ok} title={!custom && !copied ? "Copy the recovery phrase first" : undefined}>Continue</button>
      </div>
    </>
  );
};

// ---------------------------------------------------------------- Settings

export const ShieldSettings = ({ actor, keys, registered, derived, backup, busy, onSavePhrase, onKeepCommittee, onForget }: {
  actor: string; keys: ShieldKeys; registered: Pt | null; derived: boolean; backup: BackupRow | null | undefined; busy: boolean;
  onSavePhrase: (passphrase: string) => Promise<void>; onKeepCommittee: () => Promise<void>; onForget: () => void;
}) => {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [fileSaved, setFileSaved] = useState(() => isFileSaved(actor));
  const [showPhrase, setShowPhrase] = useState(false);
  const [pass, setPass] = useState("");
  const [custom, setCustom] = useState(false);
  const [passCopied, setPassCopied] = useState(false);
  const payMe = `${location.origin}${PATHS.shielded}?to=${actor}`;
  const phraseSet = !!backup?.phrase, committeeKept = !!backup?.committee;
  const anyBackup = phraseSet || committeeKept || fileSaved;
  // the chain answer can arrive after this page opened; open the form when there is no phrase yet
  useEffect(() => { if (backup !== undefined && !backup?.phrase && !showPhrase && !pass) { setPass(generatePassphrase()); setShowPhrase(true); } }, [backup]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (f: () => Promise<unknown>, okText: string) => {
    setMsg(null);
    try { await f(); setMsg({ ok: true, text: okText }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const savePhrase = () => run(() => onSavePhrase(pass).then(() => { setPass(""); setPassCopied(false); setCustom(false); setShowPhrase(false); }), "Recovery phrase saved. Keep the words: they are not stored anywhere.");
  const copySecret = async () => { try { await navigator.clipboard.writeText(shieldKeyFile(actor, keys.ask)); setCopied(true); markFileSaved(actor); setFileSaved(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ } };
  return (
    <>
      <section className="section">
        <h2>{derived ? "Shielded key" : "Recovery"}</h2>
        {derived ? (
          <p className="lede">Your shielded key is derived from your wallet. Each time you sign in, one signature unlocks your notes on this device; nothing is stored here. It stays the same as long as your wallet's signing key does.</p>
        ) : (
          <>
            <p className={`recovery-status ${anyBackup ? "ok" : "warn"}`}>{anyBackup ? "Recovery is set up." : "Recovery is not set up."}</p>
            <p className="lede">{anyBackup ? "Your usable key is saved in this browser. The recovery options below get it back on another device." : "Your usable key is saved in this browser. Set up recovery so you can reach your shielded notes on another device."}</p>
            <details className="explain" style={{ marginBottom: 18 }}>
              <summary>Learn more</summary>
              <div className="body">
                <p>Your wallet signs with a passkey, so this app keeps a saved key for you instead of deriving one from a signature. The key reads your notes and builds the proofs that spend them. It is separate from your wallet's signing key, and spending always needs your wallet as well. Any one of the three methods below gets the key back on another device.</p>
              </div>
            </details>
          </>
        )}
        {msg ? <div style={{ margin: "4px 0 18px" }}><Note level={msg.ok ? "ok" : "error"}>{msg.text}</Note></div> : null}
        {!derived ? (
          <div className="methods">
            <div className="method">
              <div className="what"><b>Recovery phrase</b><span>Seven words that restore the key on any device.</span></div>
              <span className={`status ${phraseSet ? "yes" : "no"}`}>{backup === undefined ? "Checking" : phraseSet ? "Set" : "Not set"}</span>
              {!showPhrase ? <button className="textbtn" onClick={() => { setPass(generatePassphrase()); setCustom(false); setPassCopied(false); setShowPhrase(true); }}>{phraseSet ? "Change" : "Set up"}</button> : <span />}
            </div>
            {showPhrase ? (
              <div className="method-form">
                <PhraseInput pass={pass} setPass={setPass} custom={custom} setCustom={setCustom} copied={passCopied} setCopied={setPassCopied} replacing={phraseSet} />
                <div className="row">
                  <button className="btn private" onClick={savePhrase} disabled={busy || (custom ? !!passphraseProblem(pass) : !passCopied)} title={!custom && !passCopied ? "Copy the phrase first" : undefined}>{busy ? "Saving" : phraseSet ? "Save new phrase" : "Save phrase"}</button>
                  {phraseSet ? <button className="textbtn quiet" onClick={() => { setShowPhrase(false); setPass(""); }}>Cancel</button> : null}
                </div>
                <p className="small muted" style={{ margin: "10px 0 0" }}>Saving is one wallet signature and stores the encrypted copy on chain.</p>
              </div>
            ) : null}
            <div className="method">
              <div className="what"><b>Committee copy</b><span>The XPR Network committee can return the key after you prove you own the account. It already opens every note, and spending still needs your wallet.</span></div>
              <span className={`status ${committeeKept ? "yes" : "no"}`}>{backup === undefined ? "Checking" : committeeKept ? "Kept" : "Not kept"}</span>
              {!committeeKept && backup !== undefined ? <button className="textbtn" onClick={() => run(onKeepCommittee, "Recovery copy stored with the committee.")} disabled={busy}>{busy ? "Storing" : "Keep a copy"}</button> : <span />}
            </div>
            <div className="method">
              <div className="what"><b>Key file</b><span>The raw key as a file. Keep it private: anyone with it can read your notes.</span></div>
              <span className={`status ${fileSaved ? "yes" : "no"}`}>{fileSaved ? "Downloaded" : "Not downloaded"}</span>
              <button className="textbtn" onClick={() => { downloadKeyFile(actor, keys.ask); setFileSaved(true); }}>Download</button>
            </div>
          </div>
        ) : null}
        <details>
          <summary>{derived ? "Advanced: export a backup" : "Advanced: key details, or forget this key"}</summary>
          <div className="kv">
            <span className="k">Public key</span>
            <span className="mono">{sh.keyFingerprint(keys.pk)}</span>
            <span className="k">On chain</span>
            <span>{registered ? "Registered: others can pay you by name." : "Not registered yet."}</span>
          </div>
          <div className="row" style={{ marginBottom: 16 }}>
            {derived ? <button className="btn secondary" onClick={() => downloadKeyFile(actor, keys.ask)}>Export key file</button> : null}
            <button className="textbtn" onClick={copySecret}>{copied ? "Copied" : "Copy key file"}</button>
            {derived ? <span className="small muted">Your key is re-derived from your wallet's signature, so normally there is nothing to keep. Export a backup before you change your wallet's keys: a new signing key gives a different signature, and with it a different key.</span> : null}
          </div>
          {!derived ? (
            <div className="row">
              <button className="btn danger" onClick={() => { if (confirm("Forget the shielded key on this device? Without the recovery phrase, a committee copy or the key file you lose access to these notes.")) onForget(); }}>Forget key on this device</button>
            </div>
          ) : null}
        </details>
      </section>
      {registered ? (
        <section className="section divided">
          <h2>Pay-me link</h2>
          <p className="lede">Share this and the Send form opens with your name filled in.</p>
          <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
            <code className="mono payme">{payMe}</code>
            <button className="textbtn" onClick={async () => { try { await navigator.clipboard.writeText(payMe); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); } catch { /* selectable */ } }}>{linkCopied ? "Copied" : "Copy link"}</button>
          </div>
        </section>
      ) : null}
    </>
  );
};

// ---------------------------------------------------------------- Activity

const when = (ts: string | null) => (ts ? new Date(ts.endsWith("Z") ? ts : ts + "Z").toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

export const ShieldActivity = ({ cfg, keys, actor, notes, spent, token, revealed, onReveal }: {
  cfg: ShieldConfig; keys: ShieldKeys; actor: string; notes: OwnedNote[] | null; spent: OwnedNote[]; token: Token; revealed: boolean; onReveal: (v: boolean) => void;
}) => {
  const [ev, setEv] = useState<{ events: ActivityEvent[]; history: boolean } | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  useEffect(() => {
    if (!notes) return;
    let live = true;
    sh.activity(keys, actor, { notes, spent }).then((r) => { if (live) setEv(r); }).catch(() => { if (live) setEv({ events: [], history: false }); });
    return () => { live = false; };
  }, [keys, actor, notes, spent]);
  const all = useMemo(() => [...(notes ?? []).map((n) => ({ n, spent: false })), ...spent.map((n) => ({ n, spent: true }))].sort((a, b) => b.n.index - a.n.index), [notes, spent]);
  const label = (e: ActivityEvent) => e.kind === "deposit" ? "Deposited" : e.kind === "withdrew" ? `Withdrew to ${e.counterparty}` : e.kind === "received" ? (e.counterparty ? `Received from ${e.counterparty}` : "Received") : e.counterparty ? `Sent to ${e.counterparty}` : "Sent";
  const sub = (e: ActivityEvent) => e.kind === "deposit" ? "public" : e.kind === "withdrew" ? "public" : e.kind === "sent" ? (e.change && e.change > 0n ? `sealed; change ${fmtUnits(e.change, tokenOf(cfg, e.token, token))} kept as note ${e.changeNote}` : "sealed") : e.counterparty ? "sealed; the payer is named by the signed transaction" : "sealed; payer not yet in history";
  return (
    <section className="section">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2>Activity</h2>
        <button className="textbtn" onClick={() => onReveal(!revealed)} aria-pressed={revealed}>{revealed ? "Hide" : "Reveal"}</button>
      </div>
      <p className="lede">What happened, newest first. Deposits and withdrawals are public on chain; payments are sealed, and only you, the other party and the auditor can read them.</p>
      {notes === null || ev === null ? <div className="empty">Reading your notes</div> : ev.events.length === 0 ? <p className="muted">Nothing yet.</p> : (
        <table className="ledger">
          <thead><tr><th>When</th><th>What</th><th className="amount">Amount</th></tr></thead>
          <tbody>
            {ev.events.map((e, i) => {
              const t = tokenOf(cfg, e.token, token);
              const out = e.kind === "sent" || e.kind === "withdrew";
              const pub = e.kind === "deposit" || e.kind === "withdrew";
              return (
                <tr key={`${e.trx ?? "x"}-${e.kind}-${i}`}>
                  <td className="mono">{e.trx ? <a href={sh.txLink(e.trx)} target="_blank" rel="noreferrer">{when(e.ts)}</a> : <span className="muted">not in history</span>}</td>
                  <td>{label(e)}<span className="small muted" style={{ display: "block" }}>{sub(e)}</span></td>
                  <td className="amount"><span className="tok"><TokenIcon code={t.code} size={16} /></span> {out ? "−" : "+"}<Amount value={e.amount} hidden={!pub} revealed={revealed} size="plain" token={t} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {ev && !ev.history ? <p className="small muted" style={{ marginTop: 10 }}>No history node answered, so times and payers are missing; the notes below are read from the contract directly.</p> : null}
      {all.length ? (
        <details style={{ marginTop: 22 }} open={showNotes} onToggle={(e) => setShowNotes((e.target as HTMLDetailsElement).open)}>
          <summary>The notes behind this ({all.length})</summary>
          <p className="small muted">Money inside is held as sealed notes. A payment spends whole notes and returns the change as a new note, so one payment can touch several rows here.</p>
          <table className="ledger">
            <thead><tr><th>Note</th><th>What</th><th>Status</th><th className="amount">Amount</th></tr></thead>
            <tbody>
              {all.map(({ n, spent: sp }) => {
                const t = tokenOf(cfg, n.token, token);
                return (
                  <tr key={n.index}>
                    <td className="mono">{n.index}</td>
                    <td>{n.kind === "deposit" ? "Deposit, public" : "Sealed note"}</td>
                    <td>{sp ? "spent" : "unspent"}</td>
                    <td className="amount"><span className="tok"><TokenIcon code={t.code} size={16} /></span> <Amount value={n.v} hidden={n.kind !== "deposit"} revealed={revealed} size="plain" token={t} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  );
};

// ---------------------------------------------------------------- Auditor

export const ShieldAuditor = ({ cfg, token }: { cfg: ShieldConfig; token: Token }) => {
  const [secret, setSecret] = useState("");
  const [rows, setRows] = useState<ShieldLedgerRow[] | null>(null);
  const [edges, setEdges] = useState<ShieldEdges | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { sh.shieldEdges(cfg).then(setEdges).catch(() => setEdges(null)); }, [cfg]);
  const open = async () => {
    setBusy(true); setErr(null); setRows(null);
    try {
      const k = keygen(BigInt(secret.trim().startsWith("0x") ? secret.trim() : /^[0-9]+$/.test(secret.trim()) ? secret.trim() : "0x" + secret.trim()));
      if (k.pk[0] !== cfg.auditorPk[0] || k.pk[1] !== cfg.auditorPk[1]) throw new Error("That is not the auditor key configured on this contract.");
      setRows(await sh.auditorLedger(secret));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="section">
      <h2>Auditor</h2>
      <p className="lede">The committee's viewing key opens every sealed note: who received it and how much. The account that paid is the one that signed the spend on chain. The key never leaves this browser.</p>
      {edges ? (
        <div className="kv">
          {Object.keys(edges.deposits).map((code) => {
            const t = cfg.tokens.find((e) => e.token.code === code)?.token ?? token;
            const expected = edges.deposits[code] - (edges.withdrawals[code] ?? 0n);
            return [
              <span className="k" key={code + "k"}>{code} in escrow</span>,
              <span key={code + "v"}>{fmtUnits(edges.escrow[code] ?? 0n, t)} held. {(() => { const held = edges.escrow[code] ?? 0n; const unf = edges.unfinished[code] ?? 0n; const diff = held - expected - unf; return diff === 0n ? "Matches deposits minus withdrawals." : diff > 0n ? `${fmtUnits(diff, t)} more than deposits minus withdrawals.` : `${fmtUnits(-diff, t)} short of deposits minus withdrawals.`; })()}{(edges.unfinished[code] ?? 0n) > 0n ? ` ${fmtUnits(edges.unfinished[code], t)} arrived but is not yet placed.` : ""}</span>,
            ];
          })}
          <span className="k">Notes</span>
          <span>{edges.leaves} placed, {edges.nullifiers} spent</span>
        </div>
      ) : null}
      <Field label="Auditor viewing key" hint="The committee's spending scalar for the shielded contract, as hex or decimal." error={err ?? undefined}>
        <input className="mono" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="0x…" autoComplete="off" />
      </Field>
      <div className="row" style={{ marginBottom: 18 }}>
        <button className="btn private" onClick={open} disabled={!secret.trim() || busy}>{busy ? "Opening" : "Open the ledger"}</button>
      </div>
      {rows ? (
        rows.length === 0 ? <p className="muted">No notes yet.</p> : (
          <table className="ledger">
            <thead><tr><th>Note</th><th>From</th><th>To</th><th className="amount">Amount</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const t = tokenOf(cfg, r.token, token);
                return (
                  <tr key={r.index} className={r.valid ? "" : "warn"}>
                    <td className="mono">{r.index}</td>
                    <td>{r.from}</td>
                    <td>{r.to}</td>
                    <td className="amount">{r.valid ? `${fmtUnits(r.amount, t)} ${t.code}` : "does not match the commitment"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      ) : null}
      <p className="small muted" style={{ marginTop: 14 }}>"Unknown" senders appear where no history service is reachable; the contract's own tables do not store the signer. Explorer: <a href={`${EXPLORER}/account/${SHIELD.contract}`}>{SHIELD.contract}</a>.</p>
    </section>
  );
};

// ---------------------------------------------------------------- How it works

export const ShieldAbout = ({ onConnect, signedIn }: { onConnect?: () => void; signedIn: boolean }) => (
  <section className="about">
    <h1>How shielded payments work</h1>
    <p className="lede">Money goes in and comes out in public. Inside, it moves as sealed notes: a payment shows who paid, and nothing else.</p>
    <h2>Deposit</h2>
    <p>You send XPR or XMD to the contract with your wallet, as an ordinary transfer. The contract turns it into a sealed note to your key and adds the note's fingerprint to a tree. The deposit and its amount are public, like any transfer.</p>
    <h2>Pay</h2>
    <p>To pay someone, your device proves, without revealing which, that you hold notes worth at least the amount, and produces two new sealed notes: one to the receiver, one with your change, in random order. Your wallet signs the transaction. The chain records that you paid, the two new fingerprints, and two one-way tags that stop the old notes being spent again. It does not record the receiver, the amount, or which notes you used.</p>
    <h2>Receive</h2>
    <p>Your device scans the contract's notes and recognises the ones sealed to your key. Nobody else can list them or read the amounts. You can spend them the moment they land.</p>
    <h2>Withdraw</h2>
    <p>A withdrawal spends notes and pays public tokens to your own account. The chain sees that you withdrew this amount to yourself; it does not see which notes.</p>
    <h2>The auditor</h2>
    <p>Every note is also sealed to the XPR Network committee's viewing key, and the proof enforces it: a note the auditor cannot read cannot be created. The auditor sees who received what, and the signed transaction says who paid. This is compliant privacy, not anonymity.</p>
    <h2>What stays visible</h2>
    <ul className="plain">
      <li>Who initiated each payment, and when.</li>
      <li>Deposits and withdrawals, with amounts and names.</li>
      <li>Whether a payment spent one note or two.</li>
      <li>The set of accounts that have set up shielded payments.</li>
    </ul>
    <p>With few users, "someone paid someone" narrows quickly, and a receiver who spends right after being paid links the two by timing. Those limits are real and are written down in the design.</p>
    <h2>Your key</h2>
    <p>Your shielded key is derived from one wallet signature over a fixed message that is never sent to the chain. The same wallet gives the same key on any device. The key reads and proves; only your wallet's signature moves anything. Wallets that sign differently each time keep a saved key instead, with a secret you copy once.</p>
    {!signedIn && onConnect ? (
      <div className="cta row">
        <button className="btn private" onClick={onConnect}>Connect wallet</button>
      </div>
    ) : null}
  </section>
);
