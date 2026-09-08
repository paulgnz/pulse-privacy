import { useEffect, useMemo, useState } from "react";
import { EXPLORER, NETWORK, NETWORK_LABEL, PATHS, SHIELD } from "../config";
import type { Pt } from "../lib/crypto/babyjub";
import { UNITS, fmtUnits } from "../lib/format";
import * as sh from "../lib/shield/chain";
import type { ActivityEvent, BackupRow, ShieldConfig, ShieldEdges, ShieldLedgerRow } from "../lib/shield/chain";
import { shieldKeyFile } from "../lib/shield/backup";
import { MIN_PASSPHRASE, generatePassphrase, passphraseProblem } from "../lib/keys";
import type { OwnedNote, ShieldKeys } from "../lib/shield/notes";
import { keygen } from "../lib/shield/notes";
import type { Token } from "../lib/token";
import { Amount } from "./Amount";
import { Field, Line, Note, TokenIcon } from "./ui";
import { ShieldWalkthrough } from "./ShieldWalkthrough";

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
      <p className="small muted" style={{ margin: "0 0 10px" }}>{replacing ? "Copy the new words before you save. Saving replaces the copy on chain, so the old words no longer open the current copy. They still open any copy someone saved from chain history, and the key itself does not change: if the old words may have leaked, treat the key as exposed and move your money to a new account." : "Copy the words before you save. An encrypted copy of the key goes on chain; only these words open it, and they are not stored anywhere."}</p>
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
          <span>{edges.leaves} placed; tree {edges.activeTree + 1} of {edges.trees} in use, {edges.slotsUsed.toLocaleString()} of {edges.capacity.toLocaleString()} slots ({(100 * edges.slotsUsed / edges.capacity).toFixed(2)}%; a full tree rolls over to a fresh one on its own); {edges.nullifiers} spend tags (every payment leaves two, one of them a decoy when a single note was spent)</span>
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

const CEREMONY_URL = "https://ceremony.private.protonnz.com";

/** the shielded contract's tokens and caps, read from the contract */
const ShieldLimits = ({ tokens }: { tokens: Token[] }) => {
  const [cfg, setCfg] = useState<ShieldConfig | null | undefined>(undefined);
  useEffect(() => { sh.getConfig(tokens).then(setCfg).catch(() => setCfg(null)); }, [tokens]);
  if (cfg === undefined) return <p className="muted">Reading the contract</p>;
  if (!cfg || !cfg.tokens.length) return <p className="muted">The contract's limits could not be read right now.</p>;
  const whole = (v: bigint, t: Token) => fmtUnits(v, t, { trim: true });
  return (
    <div className="limits">
      <table>
        <thead><tr><th>Token</th><th>Per deposit</th><th>In the contract</th><th>Withdrawals</th></tr></thead>
        <tbody>
          {cfg.tokens.map((r) => (
            <tr key={r.token.code}>
              <td><span className="tok"><TokenIcon code={r.token.code} />{r.token.code}</span></td>
              <td>{r.maxDeposit ? `up to ${whole(r.maxDeposit, r.token)}` : "no cap"}</td>
              <td>{r.maxPool ? `${whole(r.pool, r.token)} of ${whole(r.maxPool, r.token)}` : whole(r.pool, r.token)}</td>
              <td>any amount, to your own account</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** a three-line shielded statement: what each party sees */
const ShieldExcerpt = () => (
  <div className="excerpt" aria-label="Example statement">
    <Line label="Deposit" sub="public, like any transfer">
      <Amount value={5000n * UNITS} />
    </Line>
    <Line label="Sent" sub="the chain shows that you paid, and nothing else">
      <Amount value={1234n * UNITS} hidden />
    </Line>
    <Line label="Received" sub="only you, the payer and the auditor can see this exists">
      <Amount value={250n * UNITS} hidden digits={8} />
    </Line>
  </div>
);

/** Alice pays Bob: what each party can read */
const WhoSees = () => (
  <div className="limits">
    <table>
      <thead><tr><th>Alice pays Bob 250 XPR</th><th>The public</th><th>Bob</th><th>The auditor</th></tr></thead>
      <tbody>
        <tr><td>Alice paid someone</td><td>yes, signed</td><td>yes</td><td>yes</td></tr>
        <tr><td>The receiver is Bob</td><td>no</td><td>yes</td><td>yes</td></tr>
        <tr><td>The amount, 250 XPR</td><td>no</td><td>yes</td><td>yes</td></tr>
        <tr><td>Which of Alice's notes were spent</td><td>no</td><td>no</td><td>no, only their total</td></tr>
        <tr><td>Alice's change</td><td>no</td><td>no</td><td>yes</td></tr>
      </tbody>
    </table>
  </div>
);

/** How it works, shielded. Facts follow docs/06-shielded-design.md; written for a user. */
export const ShieldAbout = ({ onConnect, signedIn, tokens = [] }: { onConnect?: () => void; signedIn: boolean; tokens?: Token[] }) => (
  <article className="about">
    <section>
      <h1>How Private XPR works</h1>
      <p>
        Private XPR is money you hold inside a contract on XPR Network, as sealed notes. It holds XPR and XMD, the Metal Dollar,
        and more tokens can be added. You deposit ordinary tokens into it, and from then on every payment you make is a new sealed
        note to the receiver. The chain records that you paid, and when. It shows neither whom nor how much.
      </p>
      <p className="coins" aria-label="Tokens held">
        <span className="tok"><TokenIcon code="XPR" size={28} />XPR</span>
        <span className="tok"><TokenIcon code="XMD" size={28} />XMD, the Metal Dollar</span>
      </p>
      <p>
        Three parties can read a payment: the payer, the receiver, and a designated auditor. Nobody else can, including the validators
        that run the network. Your wallet keeps working as it does today: it signs every payment, and needs no changes.
      </p>
    </section>

    <section>
      <h2>Three ideas make this work</h2>

      <h3>Sealed notes instead of a balance</h3>
      <p>
        Your money inside is a set of notes, each sealed to your key with an amount inside. Paying someone spends whole notes and
        creates two new ones: one sealed to the receiver, one back to you with the change. Only the fingerprint of each note goes
        on chain, in a tree the contract maintains. Nobody can tell from the fingerprint whose note it is or what it holds.
      </p>
      <ShieldExcerpt />

      <h3>A zero-knowledge proof instead of an open ledger</h3>
      <p>
        Before a payment is accepted, your device attaches a zero-knowledge proof: a short piece of mathematics that shows a
        statement is true without revealing anything else about it. Here the statement is that the notes you are spending exist in
        the tree, they are yours, they have not been spent before, and the new notes add up to the old ones. The network checks the
        proof in a few milliseconds and learns only that it holds, not which notes were involved or what they are worth. Each spent
        note leaves a one-way tag behind so it can never be spent again, and every payment leaves two tags, one of them a decoy when a
        single note was spent, so the number of notes stays hidden too.
      </p>
      <p>
        The proofs are Groth16 proofs, the system used by Zcash, made in your browser in about two seconds. They need a one-time
        public setup, which is what the ceremony below is for.
      </p>

      <h3>Two keyholes on every note</h3>
      <p>
        Each note is sealed to the receiver's key and to the auditor's key, and the proof checks both. A note the auditor cannot
        read cannot be created. That is what makes this shielded rather than anonymous.
      </p>
    </section>

    <section>
      <h2>Who can read a payment</h2>
      <p>See Alice pay Bob, then compare what each party can read.</p>
      <ShieldWalkthrough />
      <h3 style={{ marginTop: 26 }}>Party by party</h3>
      <WhoSees />
      <p>
        The one thing the public always sees is the payer's signature. There is no anonymous sending: every payment is signed by the
        account that makes it, which is what keeps the system compliant.
      </p>
    </section>

    <section>
      <h2>Getting started</h2>
      <ol className="howto">
        <li>Connect your WebAuth wallet. Nothing is sent to the chain.</li>
        <li>Sign one message. For most wallets the signature becomes your shielded key, the same on every device, with nothing to write down. Passkey wallets sign differently each time, so they get a saved key and a seven-word recovery phrase instead.</li>
        <li>Register once. This publishes the public half of your key under your name, so anyone can pay you by name. It is the only time your account and your key appear together on chain.</li>
        <li>Deposit XPR or XMD from your public balance. From here on, pay any registered account, or withdraw to your own account.</li>
      </ol>
      <p>
        Paying asks your wallet for one signature per payment; the proof is built on your device just before it, in about a second.
        If your browser blocks the wallet's popup, allow popups for this site.
      </p>
    </section>

    <section>
      <h2>Notes and change</h2>
      <p>
        A payment spends whole notes, so one payment can touch several rows in your activity: the notes spent, the note the receiver
        gets, and your change. A payment spends at most two notes at once; if your balance is spread across many small notes, the
        app pays in more than one step. Incoming notes are yours the moment they land, with nothing to accept.
      </p>
    </section>

    <section>
      <h2>What is public and what is hidden</h2>
      <div className="cols">
        <div>
          <h3>Public</h3>
          <ul>
            <li>Who made each payment, and when</li>
            <li>Deposits into the contract, with amounts</li>
            <li>Withdrawals out of it, with amounts</li>
            <li>Which accounts have set up shielded payments</li>
          </ul>
        </div>
        <div>
          <h3>Hidden</h3>
          <ul>
            <li>Who was paid</li>
            <li>Every payment amount</li>
            <li>Every note and balance inside the contract</li>
            <li>Readable only by the payer, the receiver and the auditor</li>
          </ul>
        </div>
      </div>
    </section>

    <section>
      <h2>Privacy at the edges</h2>
      <p>
        Money enters and leaves the contract in public, because a deposit and a withdrawal move ordinary tokens. Withdrawals go
        only to your own account, so a withdrawal is never a hidden payment to someone else.
      </p>
      <p>
        Inside, payments are hidden by cryptography. At the edges they are hidden by time and volume. With few users, "someone paid
        someone" narrows quickly, and a receiver who withdraws exactly what they were paid, right after being paid, links the two by
        timing. The private path is to keep money inside and pay other shielded accounts directly.
      </p>
    </section>

    <section>
      <h2>The auditor</h2>
      <p>
        One viewing key, held by the XPR Network committee, opens every note: the receiver and the amount. The payer is named by the
        signed transaction. The key cannot spend. This is the difference between shielded and anonymous: the details are hidden from
        the public, not from oversight. The auditor page shows what that key sees.
      </p>
    </section>

    <section>
      <h2>If you lose your key</h2>
      <p>
        For most accounts the key comes back from your wallet's signature every time, so there is nothing to lose. Passkey accounts
        keep a saved key, and three things bring it back on another device: the seven-word recovery phrase, a key file, or an encrypted
        copy kept with the XPR Network committee, which returns the key after you prove you own the account. Set these up in Settings.
        And if a key is ever beyond recovery, the committee can pause the contract and return an account's money from escrow, using
        what its viewing key can read. Money in the contract is recoverable; it is never simply gone.
      </p>
    </section>

    <section>
      <h2>Tokens and limits</h2>
      <p>This is an early release, so the contract caps what it holds. The caps are set on chain and will be raised in steps.</p>
      <ShieldLimits tokens={tokens} />
    </section>

    <section>
      <h2>Status</h2>
      <ul className="plain">
        <li>
          Running on {NETWORK_LABEL}. Contract{" "}
          <a href={`${EXPLORER}/account/${SHIELD.contract}`} target="_blank" rel="noreferrer">{SHIELD.contract}</a>
          {NETWORK === "mainnet" ? ", owned by the XPR Network committee." : ", a testnet account. Mainnet follows the ceremony."}
        </li>
        <li>Zero-knowledge proofs are generated in your browser and take about two seconds. The network checks one in about six milliseconds.</li>
        <li>
          The proving key comes from a one-person rehearsal until the public ceremony completes. Anyone can{" "}
          <a href={CEREMONY_URL} target="_blank" rel="noreferrer">contribute randomness</a>; as long as one contributor was honest, nobody can forge a proof.
          The first phase of the ceremony is shared with the confidential contract; the second is run for this circuit.
        </li>
        <li>The code has been through two independent reviews and has not been audited yet. The caps above bound what is at stake until it has.</li>
        <li>
          The design, the circuit and the contract are public:{" "}
          <a href="https://github.com/paulgnz/pulse-privacy" target="_blank" rel="noreferrer">github.com/paulgnz/pulse-privacy</a>.
        </li>
      </ul>
      {!signedIn && onConnect ? (
        <p className="cta">
          <button className="btn big" onClick={onConnect}>Connect wallet</button>
        </p>
      ) : null}
    </section>
  </article>
);
