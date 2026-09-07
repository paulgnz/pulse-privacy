import { useMemo, useState } from "react";
import type { ConfState } from "../lib/client";
import { amountProblem, fmtUnits, parseUnits } from "../lib/format";
import { roundDown, checkWithdrawal, isRound } from "../lib/privacy";
import { AmountInput, EdgeNote, Field, Note, Progress } from "./ui";

export const Withdraw = ({
  st,
  onWithdraw,
  busy,
  onClose,
  tokens,
  onSelectToken,
  onDone,
  allTokens,
  onWithdrawAll,
}: {
  st: ConfState;
  onWithdraw: (amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
  busy: boolean;
  onClose: () => void;
  tokens?: { code: string }[];
  onSelectToken?: (code: string) => void;
  /** success: the parent shows the confirmation at the top of the statement and closes the form */
  onDone?: (msg: string, txid?: string) => void;
  /** every token's figures, for "withdraw everything" */
  allTokens?: { st: ConfState; publicBalance: bigint | null }[];
  onWithdrawAll?: (code: string, amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
}) => {
  const [amt, setAmt] = useState("");
  const [prog, setProg] = useState<{ f: number; s: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [ack, setAck] = useState(false);
  const [allBusy, setAllBusy] = useState<string | null>(null);

  const T = st.token;
  const parsed = useMemo(() => {
    try {
      return amt ? parseUnits(amt, T) : null;
    } catch {
      return null;
    }
  }, [amt, T]);
  const spendable = st.balance + st.pending;
  const over = parsed !== null && parsed > spendable;
  const g = st.config.withdrawGranularity;
  const check = parsed ? checkWithdrawal(parsed, st.incoming, st.edgesSinceLastIncoming, st.config) : null;
  const chainRejects = parsed !== null && g > 0n && !isRound(parsed, g, T.units);
  const needsAck = check?.level === "warn" && !chainRejects;
  const can = !!parsed && parsed > 0n && !over && !chainRejects && !busy && (!needsAck || ack);
  const maxAmount = roundDown(spendable, g, T.units);
  const setMax = () => setAmt(fmtUnits(maxAmount, T, { trim: true }).replace(/,/g, ""));
  // other tokens with something to withdraw
  const othersWithBalance = (allTokens ?? []).filter((f) => f.st.token.code !== T.code && f.st.balance + f.st.pending > 0n);
  const withdrawAll = async () => {
    if (!onWithdrawAll) return;
    setResult(null);
    const list = [{ st, publicBalance: null as bigint | null }, ...othersWithBalance].filter((f) => f.st.balance + f.st.pending > 0n);
    try {
      for (const f of list) {
        const a = roundDown(f.st.balance + f.st.pending, f.st.config.withdrawGranularity, f.st.token.units);
        if (a <= 0n) continue;
        setAllBusy(f.st.token.code);
        setProg({ f: 0, s: `Withdrawing ${fmtUnits(a, f.st.token)} ${f.st.token.code}` });
        await onWithdrawAll(f.st.token.code, a, (fr, s) => setProg({ f: fr, s: `${f.st.token.code}: ${s}` }));
      }
      const done = `Withdrew everything to your public balance: ${list.map((f) => `${fmtUnits(roundDown(f.st.balance + f.st.pending, f.st.config.withdrawGranularity, f.st.token.units), f.st.token)} ${f.st.token.code}`).join(", ")}.`;
      if (onDone) onDone(done); else setResult({ ok: true, msg: done });
    } catch (e) {
      setResult({ ok: false, msg: `Stopped. ${(e as Error).message}` });
    } finally {
      setAllBusy(null);
      setProg(null);
    }
  };

  const go = async () => {
    if (!parsed) return;
    setResult(null);
    setProg({ f: 0, s: "Starting" });
    try {
      const tx = await onWithdraw(parsed, (f, s) => setProg({ f, s }));
      const done = `Withdrew ${fmtUnits(parsed, T)} ${T.code} to your public balance.`;
      if (onDone) onDone(done, tx); else setResult({ ok: true, msg: done });
      setAmt("");
      setAck(false);
    } catch (e) {
      setResult({ ok: false, msg: `Not withdrawn. ${(e as Error).message}` });
    } finally {
      setProg(null);
    }
  };

  return (
    <div className="form" aria-label="Withdraw">
      <h3>Withdraw</h3>
      <p>Withdrawing moves {T.code} back out as a public transfer. Keep it for when you need public {T.code}; paying inside the contract is the private path.</p>
      <Field
        label="Amount"
        error={over ? `More than you can spend. You have ${fmtUnits(spendable, T)} ${T.code}.` : chainRejects ? `The contract accepts whole multiples of ${fmtUnits(g, T, { trim: true })} ${T.code}.` : amountProblem(amt, T) ?? undefined}
        hint={`You can withdraw up to ${fmtUnits(spendable, T)} ${T.code}${g > 0n ? `, in multiples of ${fmtUnits(g, T, { trim: true })}` : ""}.`}
      >
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <AmountInput value={amt} onChange={setAmt} autoFocus token={T} tokens={tokens} onSelectToken={onSelectToken} />
          <button type="button" className="textbtn" onClick={setMax} disabled={maxAmount <= 0n}>Max</button>
        </div>
      </Field>
      {!chainRejects && check ? <EdgeNote check={check} token={T} onSuggest={(a) => setAmt(fmtUnits(a, T, { trim: true }).replace(/,/g, ""))} /> : null}
      {needsAck ? (
        <label className="check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>I understand this amount can be linked to something I received, and I want to withdraw it anyway.</span>
        </label>
      ) : null}
      {prog ? (
        <Progress fraction={prog.f} stage={prog.s} />
      ) : (
        <div className="row" style={{ marginBottom: 16 }}>
          <button className="btn" onClick={go} disabled={!can}>
            {parsed && parsed > 0n && !over && !chainRejects ? `Withdraw ${fmtUnits(parsed, T)} ${T.code}` : "Withdraw"}
          </button>
          <button className="textbtn quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      )}
      {result ? <Note level={result.ok ? "ok" : "error"}>{result.msg}</Note> : null}
      <div className="kv">
        <span className="k">Pool activity since your last incoming transfer</span>
        <span className="num">{st.edgesSinceLastIncoming}</span>
        <span className="k">Incoming transfers on record</span>
        <span className="num">{st.incoming.length}</span>
      </div>
      {onWithdrawAll && othersWithBalance.length && !prog ? (
        <div className="row" style={{ marginBottom: 16 }}>
          <button className="textbtn" onClick={withdrawAll} disabled={busy || !!allBusy}>
            Withdraw everything ({[T, ...othersWithBalance.map((f) => f.st.token)].map((t) => t.code).join(" and ")}), one signature per token
          </button>
        </div>
      ) : null}
      <p className="small muted">Inside, amounts are hidden by cryptography. At the edge they are hidden by round numbers, time and volume. Splitting a withdrawal does not help; an observer sums.</p>
    </div>
  );
};
