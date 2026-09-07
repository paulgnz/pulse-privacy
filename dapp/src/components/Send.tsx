import { useMemo, useState } from "react";
import type { ConfState } from "../lib/client";
import { amountProblem, fmtUnits, parseUnits } from "../lib/format";
import { AmountInput, Field, Note, Progress } from "./ui";

export const Send = ({
  st,
  onSend,
  busy,
  onClose,
  tokens,
  onSelectToken,
  onDone,
  publicBalance,
  onDepositFirst,
}: {
  st: ConfState;
  onSend: (to: string, amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
  busy: boolean;
  onClose: () => void;
  tokens?: { code: string }[];
  onSelectToken?: (code: string) => void;
  /** success: the parent shows the confirmation at the top of the statement and closes the form */
  onDone?: (msg: string, txid?: string) => void;
  /** the public balance, to suggest a deposit when the confidential one is short */
  publicBalance?: bigint | null;
  onDepositFirst?: (amount: bigint) => void;
}) => {
  // pay-me link: ?to=<account> opens the form with the recipient filled in
  const [to, setTo] = useState(() => {
    const q = (new URLSearchParams(location.search).get("to") ?? "").trim().toLowerCase();
    return /^[a-z1-5.]{1,12}$/.test(q) ? q : "";
  });
  const [amt, setAmt] = useState("");
  const [prog, setProg] = useState<{ f: number; s: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

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
  const name = to.trim();
  const peer = st.peers.find((p) => p.name === name);
  const canSend = !!parsed && parsed > 0n && !over && (!!peer || name.length >= 4) && !busy;

  const go = async () => {
    if (!parsed) return;
    setResult(null);
    setProg({ f: 0, s: "Starting" });
    try {
      const tx = await onSend(name, parsed, (f, s) => setProg({ f, s }));
      const done = `Sent ${fmtUnits(parsed, T)} ${T.code} to ${name}.`;
      if (onDone) onDone(done, tx); else setResult({ ok: true, msg: done });
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
              ? `${name} can receive ${T.code} inside the contract.`
              : st.peers.length
                ? `${name} has not registered for confidential ${T.code}. They can only receive public ${T.code}.`
                : `The receiver must have registered for confidential ${T.code}.`
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
        error={
          over ? (
            <>
              Only {fmtUnits(spendable, T)} {T.code} is inside the contract.
              {publicBalance !== null && publicBalance !== undefined && parsed !== null && publicBalance >= parsed - spendable && onDepositFirst ? (
                <>
                  {" "}You have {fmtUnits(publicBalance, T)} public {T.code}:{" "}
                  <button type="button" className="textbtn" onClick={() => onDepositFirst(parsed - spendable)}>
                    deposit {fmtUnits(parsed - spendable, T, { trim: true })} {T.code} first
                  </button>
                  .
                </>
              ) : (
                " Deposit more first."
              )}
            </>
          ) : amountProblem(amt, T) ?? undefined
        }
        hint={`${fmtUnits(spendable, T)} ${T.code} is inside the contract to spend${st.pending > 0n ? " (incoming payments included)" : ""}. Public ${T.code} has to be deposited first.`}
      >
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <AmountInput value={amt} onChange={setAmt} token={T} tokens={tokens} onSelectToken={onSelectToken} />
          <button type="button" className="textbtn" onClick={() => setAmt(fmtUnits(spendable, T, { trim: true }).replace(/,/g, ""))} disabled={spendable <= 0n}>Max</button>
        </div>
      </Field>
      {prog ? (
        <Progress fraction={prog.f} stage={prog.s} />
      ) : (
        <div className="row" style={{ marginBottom: 16 }}>
          <button className="btn private" onClick={go} disabled={!canSend}>
            {parsed && parsed > 0n && !over ? `Send ${fmtUnits(parsed, T)} ${T.code}` : "Send"}
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
