import { useMemo, useState } from "react";
import type { ConfState } from "../lib/client";
import { fmtUnits, parseUnits } from "../lib/format";
import { checkWithdrawal, isRound } from "../lib/privacy";
import { AmountInput, EdgeNote, Field, Note, Progress } from "./ui";

export const Withdraw = ({
  st,
  onWithdraw,
  busy,
  onClose,
}: {
  st: ConfState;
  onWithdraw: (amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
  busy: boolean;
  onClose: () => void;
}) => {
  const [amt, setAmt] = useState("");
  const [prog, setProg] = useState<{ f: number; s: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [ack, setAck] = useState(false);

  const parsed = useMemo(() => {
    try {
      return amt ? parseUnits(amt) : null;
    } catch {
      return null;
    }
  }, [amt]);
  const spendable = st.balance + st.pending;
  const over = parsed !== null && parsed > spendable;
  const g = st.config.withdrawGranularity;
  const check = parsed ? checkWithdrawal(parsed, st.incoming, st.edgesSinceLastIncoming, st.config) : null;
  const chainRejects = parsed !== null && g > 0n && !isRound(parsed, g);
  const needsAck = check?.level === "warn" && !chainRejects;
  const can = !!parsed && parsed > 0n && !over && !chainRejects && !busy && (!needsAck || ack);

  const go = async () => {
    if (!parsed) return;
    setResult(null);
    setProg({ f: 0, s: "Starting" });
    try {
      const tx = await onWithdraw(parsed, (f, s) => setProg({ f, s }));
      setResult({ ok: true, msg: `Withdrew ${fmtUnits(parsed)} XPR to your public balance. Transaction ${tx.slice(0, 12)}.` });
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
      <p>Withdrawing moves XPR back out as a public transfer. Keep it for when you need public XPR; paying inside the contract is the private path.</p>
      <Field
        label="Amount"
        error={over ? `More than you can spend. You have ${fmtUnits(spendable)} XPR.` : chainRejects ? `The contract accepts whole multiples of ${fmtUnits(g, { trim: true })} XPR.` : undefined}
        hint={`You can withdraw up to ${fmtUnits(spendable)} XPR${g > 0n ? `, in multiples of ${fmtUnits(g, { trim: true })}` : ""}.`}
      >
        <AmountInput value={amt} onChange={setAmt} autoFocus />
      </Field>
      {!chainRejects && check ? <EdgeNote check={check} onSuggest={(a) => setAmt(fmtUnits(a, { trim: true }).replace(/,/g, ""))} /> : null}
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
            {parsed && parsed > 0n && !over && !chainRejects ? `Withdraw ${fmtUnits(parsed)} XPR` : "Withdraw"}
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
      <p className="small muted">Inside, amounts are hidden by cryptography. At the edge they are hidden by round numbers, time and volume. Splitting a withdrawal does not help; an observer sums.</p>
    </div>
  );
};
