import { useMemo, useState } from "react";
import type { ConfState } from "../lib/client";
import { fmtUnits, parseUnits } from "../lib/format";
import { checkDeposit } from "../lib/privacy";
import { AmountInput, EdgeNote, Field, Note } from "./ui";

export const Deposit = ({
  st,
  publicBalance,
  onDeposit,
  busy,
  onClose,
}: {
  st: ConfState;
  publicBalance: bigint | null;
  onDeposit: (amount: bigint) => Promise<string>;
  busy: boolean;
  onClose: () => void;
}) => {
  const [amt, setAmt] = useState("");
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const parsed = useMemo(() => {
    try {
      return amt ? parseUnits(amt) : null;
    } catch {
      return null;
    }
  }, [amt]);
  const over = parsed !== null && publicBalance !== null && parsed > publicBalance;
  const check = parsed ? checkDeposit(parsed, st.config) : null;

  const go = async () => {
    if (!parsed) return;
    setResult(null);
    try {
      const tx = await onDeposit(parsed);
      setResult({ ok: true, msg: `Deposited ${fmtUnits(parsed)} XPR. It lands in your pending box. Transaction ${tx.slice(0, 12)}.` });
      setAmt("");
    } catch (e) {
      setResult({ ok: false, msg: `Not deposited. ${(e as Error).message}` });
    }
  };

  return (
    <div className="form" aria-label="Deposit">
      <h3>Deposit</h3>
      <p>A deposit is an ordinary XPR transfer into the contract. Everyone sees this amount. Once inside, it is a box.</p>
      <Field label="Amount" error={over ? `More than your public balance of ${fmtUnits(publicBalance ?? 0n)} XPR.` : undefined} hint={publicBalance !== null ? `Public balance ${fmtUnits(publicBalance)} XPR.` : undefined}>
        <AmountInput value={amt} onChange={setAmt} autoFocus />
      </Field>
      <div className="chips">
        {[100n, 500n, 1000n, 5000n].map((x) => (
          <button key={x.toString()} className="textbtn quiet" onClick={() => setAmt(x.toString())}>
            {x.toLocaleString("en-US")}
          </button>
        ))}
      </div>
      {check ? <EdgeNote check={check} onSuggest={(a) => setAmt(fmtUnits(a, { trim: true }).replace(/,/g, ""))} /> : null}
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn" onClick={go} disabled={!parsed || parsed <= 0n || over || !st.registered || busy}>
          {parsed && parsed > 0n && !over ? `Deposit ${fmtUnits(parsed)} XPR` : "Deposit"}
        </button>
        <button className="textbtn quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
      {result ? <Note level={result.ok ? "ok" : "error"}>{result.msg}</Note> : null}
      <p className="small muted">Your first deposit is the one number everyone sees. A round amount says less about you than a specific one.</p>
    </div>
  );
};
