import { useMemo, useState } from "react";
import type { ConfState } from "../lib/client";
import { fmtUnits, parseUnits } from "../lib/format";
import { checkWithdrawal, isRound } from "../lib/privacy";
import { AmountInput, Card, EdgeNotice, Field, Notice, Progress, Tag } from "./ui";

export const Withdraw = ({
  st,
  onWithdraw,
  busy,
}: {
  st: ConfState;
  onWithdraw: (amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
  busy: boolean;
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
  const check = parsed ? checkWithdrawal(parsed, st.incoming, st.edgesSinceLastIncoming, st.config) : null;
  const chainRejects = parsed !== null && !isRound(parsed, st.config.withdrawGranularity) && st.config.withdrawGranularity > 0n;
  const needsAck = check?.level === "warn" && !chainRejects;
  const can = !!parsed && parsed > 0n && !over && !chainRejects && !busy && (!needsAck || ack);

  const go = async () => {
    if (!parsed) return;
    setResult(null);
    setProg({ f: 0, s: "starting" });
    try {
      const tx = await onWithdraw(parsed, (f, s) => setProg({ f, s }));
      setResult({ ok: true, msg: `Withdrew ${fmtUnits(parsed)} XPR to your public balance. Transaction ${tx.slice(0, 12)}…` });
      setAmt("");
      setAck(false);
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    } finally {
      setProg(null);
    }
  };

  const g = st.config.withdrawGranularity;

  return (
    <div className="grid two">
      <Card accent="warm">
        <div className="row between">
          <h2>Withdraw</h2>
          <Tag kind="public">PUBLIC TRANSFER</Tag>
        </div>
        <p>Withdrawing moves XPR back out of the pool as a public transfer. It is the exception, not the routine: pay inside the pool when you can.</p>
        <div className="stack" style={{ marginTop: 16 }}>
          <Field
            label="Amount"
            hint={
              over ? (
                <span className="bad">more than your spendable balance</span>
              ) : (
                <>
                  spendable {fmtUnits(spendable)} XPR · the contract accepts multiples of {g > 0n ? fmtUnits(g, { trim: true }) : "any"} XPR
                </>
              )
            }
          >
            <AmountInput value={amt} onChange={setAmt} />
          </Field>
          {chainRejects ? (
            <Notice level="bad" title="The contract will reject this">
              Withdrawals must be a multiple of {fmtUnits(g, { trim: true })} XPR (withdraw granularity, set by the contract config).
            </Notice>
          ) : check ? (
            <EdgeNotice check={check} onSuggest={(a) => setAmt(fmtUnits(a, { trim: true }).replace(/,/g, ""))} />
          ) : null}
          {needsAck ? (
            <label className="row dim" style={{ fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand this amount is easy to link, and I want it anyway.
            </label>
          ) : null}
          {prog ? (
            <Progress fraction={prog.f} stage={prog.s} />
          ) : (
            <div>
              <button className="btn warm" onClick={go} disabled={!can}>
                Prove and withdraw
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
        <h3>Edge privacy, honestly</h3>
        <p>Inside the pool your amounts are hidden by cryptography. At the edge they are hidden by statistics: round numbers, time, and volume.</p>
        <div className="grid three" style={{ gap: 12, marginTop: 8 }}>
          <div className="stat">
            <div className="v">{st.edgesSinceLastIncoming}</div>
            <div className="k">pool edges since your last incoming</div>
          </div>
          <div className="stat">
            <div className="v">{st.incoming.length}</div>
            <div className="k">incoming transfers on record</div>
          </div>
          <div className="stat">
            <div className="v">{g > 0n ? fmtUnits(g, { trim: true }) : "off"}</div>
            <div className="k">granularity, XPR</div>
          </div>
        </div>
        <p style={{ marginTop: 14, fontSize: 13 }}>Splitting a withdrawal into chunks does not help: an analyst sums. Withdrawing to another account does not help: you still sign it. Only the amount shape and the pool's activity do the work. The wallet warns; the chain enforces the granularity; nothing here is a hard block.</p>
      </Card>
    </div>
  );
};
