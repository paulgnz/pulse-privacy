import { useMemo, useState } from "react";
import type { ConfState } from "../lib/client";
import { fmtUnits, parseUnits } from "../lib/format";
import { AmountInput, Card, Field, Notice, Progress, Tag } from "./ui";

export const Send = ({
  st,
  onSend,
  busy,
}: {
  st: ConfState;
  onSend: (to: string, amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
  busy: boolean;
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
  const peer = st.peers.find((p) => p.name === to.trim());
  const canSend = !!parsed && parsed > 0n && !over && to.trim().length >= 4 && !busy;

  const go = async () => {
    if (!parsed) return;
    setResult(null);
    setProg({ f: 0, s: "starting" });
    try {
      const tx = await onSend(to.trim(), parsed, (f, s) => setProg({ f, s }));
      setResult({ ok: true, msg: `Sent ${fmtUnits(parsed)} XPR to ${to.trim()}. Transaction ${tx.slice(0, 12)}…` });
      setAmt("");
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    } finally {
      setProg(null);
    }
  };

  return (
    <div className="grid two">
      <Card accent="peri">
        <div className="row between">
          <h2>Send confidentially</h2>
          <Tag kind="hidden">AMOUNT HIDDEN</Tag>
        </div>
        <p>The chain will show that you paid this account, and when. The amount is a box only you, they, and the auditor can open.</p>
        <div className="stack" style={{ marginTop: 16 }}>
          <Field
            label="To"
            hint={
              to.trim().length >= 4 ? (
                peer ? (
                  <span className="good">registered · can receive in the pool</span>
                ) : st.peers.length ? (
                  <span className="warm">not registered in the pool (mock directory). They would need to register first, or receive public XPR.</span>
                ) : (
                  "the receiver must have registered an encryption key"
                )
              ) : (
                "an XPR account name"
              )
            }
          >
            <input value={to} onChange={(e) => setTo(e.target.value.toLowerCase())} placeholder="bob" list="peers" autoComplete="off" />
            <datalist id="peers">
              {st.peers.map((p) => (
                <option key={p.name} value={p.name} />
              ))}
            </datalist>
          </Field>
          <Field label="Amount" hint={over ? <span className="bad">more than your spendable balance</span> : `spendable ${fmtUnits(spendable)} XPR${st.pending > 0n ? " (pending will be folded first)" : ""}`}>
            <AmountInput value={amt} onChange={setAmt} />
          </Field>
          {prog ? (
            <Progress fraction={prog.f} stage={prog.s} />
          ) : (
            <div>
              <button className="btn primary" onClick={go} disabled={!canSend}>
                Prove and send
              </button>
            </div>
          )}
          {result ? (
            <Notice level={result.ok ? "ok" : "bad"} title={result.ok ? "Done" : "Not sent"}>
              {result.msg}
            </Notice>
          ) : null}
        </div>
      </Card>
      <Card>
        <h3>What happens</h3>
        <ol className="dim" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.7 }}>
          <li>Pending credits are folded into your balance, if any.</li>
          <li>Your device decrypts your balance box and builds a proof: the amount is valid, you are not overdrawn, and the receiver's and auditor's copies match yours.</li>
          <li>WebAuth signs an ordinary transfer action carrying the boxes and the 128-byte proof. No memo.</li>
          <li>Every validator checks the proof in about two milliseconds and updates the boxes without opening them.</li>
        </ol>
        <p style={{ marginTop: 14, fontSize: 13 }}>
          No memo field on purpose. A note like <code>invoice 4471</code> leaks more than the amount ever would.
        </p>
      </Card>
    </div>
  );
};
