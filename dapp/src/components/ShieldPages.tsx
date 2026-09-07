import { useEffect, useMemo, useState } from "react";
import { APP, EXPLORER, SHIELD } from "../config";
import type { Session } from "../lib/chain";
import type { Pt } from "../lib/crypto/babyjub";
import { fmtUnits } from "../lib/format";
import * as sh from "../lib/shield/chain";
import type { ShieldConfig, ShieldEdges, ShieldLedgerRow } from "../lib/shield/chain";
import type { OwnedNote, ShieldKeys } from "../lib/shield/notes";
import { keygen } from "../lib/shield/notes";
import type { Token } from "../lib/token";
import { Amount } from "./Amount";
import { Field, TokenIcon } from "./ui";

const tokenOf = (cfg: ShieldConfig, id: bigint, fallback: Token) => cfg.tokens.find((t) => t.id === id)?.token ?? fallback;

// ---------------------------------------------------------------- Settings

export const ShieldSettings = ({ session, keys, registered, savedSecret, onForget, onCopiedSecret }: {
  session: Session; keys: ShieldKeys; registered: Pt | null; savedSecret: string | null; onForget: () => void; onCopiedSecret: () => void;
}) => {
  const actor = session.auth.actor;
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const payMe = APP === "shield" ? `${location.origin}/?to=${actor}` : `${location.origin}/shielded?to=${actor}`;
  const saved = (() => { try { return !!localStorage.getItem(`pulse-privacy/shield/${actor}`); } catch { return false; } })();
  return (
    <>
      <section className="section">
        <h2>Shielded key</h2>
        {saved ? (
          <p className="lede">This browser keeps a saved shielded key, because your wallet signs differently each time. It reads your notes and builds proofs; moving anything still needs your wallet's signature. Without the secret below, a lost or cleared browser means these notes are gone.</p>
        ) : (
          <p className="lede">Your shielded key is derived from your wallet each time you sign in, with one signature, and stays in memory only. It reads your notes and builds proofs; moving anything still needs your wallet's signature. There is nothing to back up.</p>
        )}
        {saved ? (
          <>
            <Field label="Secret" hint="Keep it where you keep important things. Anyone with it can read your notes; they cannot spend them without your wallet.">
              <div className="secret" aria-label="Your shielded secret"><code>{savedSecret ?? keys.ask.toString(16).padStart(64, "0")}</code></div>
            </Field>
            <div className="row" style={{ marginBottom: 18 }}>
              <button className="btn secondary" onClick={async () => { try { await navigator.clipboard.writeText(savedSecret ?? keys.ask.toString(16).padStart(64, "0")); setCopied(true); onCopiedSecret(); } catch { /* selectable */ } }}>{copied ? "Copied" : "Copy secret"}</button>
            </div>
          </>
        ) : null}
        <div className="kv">
          <span className="k">Public key</span>
          <span className="mono">{sh.keyFingerprint(keys.pk)}</span>
          <span className="k">On chain</span>
          <span>{registered ? "Registered: others can pay you by name." : "Not registered yet."}</span>
        </div>
        <details>
          <summary>Advanced: forget this key on this device</summary>
          <p className="small muted">Removes the key from this browser. A derived key comes back with one signature; a saved key only comes back from its secret.</p>
          <div className="row">
            <button className="btn danger" onClick={() => { if (confirm("Forget the shielded key on this device?")) onForget(); }}>Forget key on this device</button>
          </div>
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

export const ShieldActivity = ({ cfg, notes, spent, token, revealed, onReveal }: {
  cfg: ShieldConfig; notes: OwnedNote[] | null; spent: OwnedNote[]; token: Token; revealed: boolean; onReveal: (v: boolean) => void;
}) => {
  const all = useMemo(() => [...(notes ?? []).map((n) => ({ n, spent: false })), ...spent.map((n) => ({ n, spent: true }))].sort((a, b) => b.n.index - a.n.index), [notes, spent]);
  return (
    <section className="section">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2>Activity</h2>
        <button className="textbtn" onClick={() => onReveal(!revealed)} aria-pressed={revealed}>{revealed ? "Hide" : "Reveal"}</button>
      </div>
      <p className="lede">Every note of yours, newest first. Deposits are public on chain; the others are sealed, and only you, the sender and the auditor can read them.</p>
      {notes === null ? <div className="empty">Reading your notes</div> : all.length === 0 ? <p className="muted">Nothing yet.</p> : (
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
      )}
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
