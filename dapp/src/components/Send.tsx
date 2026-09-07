import { useMemo, useState } from "react";
import type { ConfState } from "../lib/client";
import { fmtUnits, parseUnits } from "../lib/format";
import { AmountInput, Field, Note, Progress } from "./ui";

export const Send = ({
  st,
  onSend,
  busy,
  onClose,
}: {
  st: ConfState;
  onSend: (to: string, amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
  busy: boolean;
  onClose: () => void;
}) => {
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [prog, setProg] = useState<{ f: number; s: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const parsed = useMemo(() => {
    try {
      return amt ? parseUnits(amt) : null;
    } catch {
      return null;
    }
  }, [amt]);
  const spendable = st.balance + st.pending;
  const over = parsed !== null && parsed > spendable;
  const name = to.trim();
  const peer = st.peers.find((p) => p.name === name);
  const canSend = !!parsed && parsed > 0n && !over && (!!peer || name.length >= 4) && !busy;

  const go = async () => {
    if (!parsed) return;
    setResult(null);
    setProg({ f: 0, s: "Starting" });
    try {
      const tx = await onSend(name, parsed, (f, s) => setProg({ f, s }));
      setResult({ ok: true, msg: `Sent ${fmtUnits(parsed)} XPR to ${name}. Transaction ${tx.slice(0, 12)}.` });
      setAmt("");
    } catch (e) {
      setResult({ ok: false, msg: `Not sent. ${(e as Error).message}` });
    } finally {
      setProg(null);
    }
  };

  return (
    <div className="form" aria-label="Send">
      <h3>Send</h3>
      <p>The chain will record that you paid this account, and when. The amount is a box only you, they and the auditor can open.</p>
      <Field
        label="To"
        hint={
          name.length >= 4
            ? peer
              ? `${name} can receive inside the contract.`
              : st.peers.length
                ? `${name} has not registered an encryption key. They can only receive public XPR.`
                : "The receiver must have registered an encryption key."
            : "An XPR account name."
        }
      >
        <input value={to} onChange={(e) => setTo(e.target.value.toLowerCase())} placeholder="bob" list="peers" autoComplete="off" autoFocus />
        <datalist id="peers">
          {st.peers.map((p) => (
            <option key={p.name} value={p.name} />
          ))}
        </datalist>
      </Field>
      <Field
        label="Amount"
        error={over ? `More than you can spend. You have ${fmtUnits(spendable)} XPR.` : undefined}
        hint={`You can spend ${fmtUnits(spendable)} XPR${st.pending > 0n ? ", after pending is folded in" : ""}.`}
      >
        <AmountInput value={amt} onChange={setAmt} />
      </Field>
      {prog ? (
        <Progress fraction={prog.f} stage={prog.s} />
      ) : (
        <div className="row" style={{ marginBottom: 16 }}>
          <button className="btn private" onClick={go} disabled={!canSend}>
            {parsed && parsed > 0n && !over ? `Send ${fmtUnits(parsed)} XPR` : "Send"}
          </button>
          <button className="textbtn quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      )}
      {result ? <Note level={result.ok ? "ok" : "error"}>{result.msg}</Note> : null}
      <p className="small muted">Your device builds the proof, WebAuth signs an ordinary action, and no memo is attached on purpose.</p>
    </div>
  );
};
