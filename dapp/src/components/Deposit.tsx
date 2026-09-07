import { useMemo, useState } from "react";
import type { ConfState } from "../lib/client";
import { fmtUnits, parseUnits } from "../lib/format";
import { checkDeposit } from "../lib/privacy";
import { AmountInput, Card, EdgeNotice, Field, Notice, Tag } from "./ui";

export const Deposit = ({
  st,
  publicBalance,
  onDeposit,
  busy,
}: {
  st: ConfState;
  publicBalance: bigint | null;
  onDeposit: (amount: bigint) => Promise<string>;
  busy: boolean;
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
      setResult({ ok: true, msg: `Deposited ${fmtUnits(parsed)} XPR into the pool. It lands in your pending box. Transaction ${tx.slice(0, 12)}…` });
      setAmt("");
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    }
  };

  return (
    <div className="grid two">
      <Card accent="warm">
        <div className="row between">
          <h2>Deposit</h2>
          <Tag kind="public">PUBLIC TRANSFER</Tag>
        </div>
        <p>A deposit is a normal XPR transfer into the contract's escrow. Everyone sees the amount. Once inside, it is a box.</p>
        {!st.registered ? (
          <Notice level="warn" title="Register first">
            The contract needs your encryption key before it can credit you a box.
          </Notice>
        ) : null}
        <div className="stack" style={{ marginTop: 16 }}>
          <Field label="Amount" hint={over ? <span className="bad">more than your public balance</span> : publicBalance !== null ? `public balance ${fmtUnits(publicBalance)} XPR` : ""}>
            <AmountInput value={amt} onChange={setAmt} />
          </Field>
          {check ? <EdgeNotice check={check} onSuggest={(a) => setAmt(fmtUnits(a, { trim: true }).replace(/,/g, ""))} /> : null}
          <div className="row">
            {[100n, 500n, 1000n, 5000n].map((x) => (
              <button key={x.toString()} className="btn ghost sm" onClick={() => setAmt(x.toString())}>
                {x.toLocaleString("en-US")}
              </button>
            ))}
          </div>
          <div>
            <button className="btn primary" onClick={go} disabled={!parsed || parsed <= 0n || over || !st.registered || busy}>
              Deposit into the pool
            </button>
          </div>
          {result ? (
            <Notice level={result.ok ? "ok" : "bad"} title={result.ok ? "Done" : "Not sent"}>
              {result.msg}
            </Notice>
          ) : null}
        </div>
      </Card>
      <Card>
        <h3>Why round numbers</h3>
        <p>Your first deposit is the one edge everyone crosses. It reveals a starting amount, once. A round amount is shared with everyone else who deposited a round amount; a specific one is a fingerprint.</p>
        <p>After a few transfers inside, an observer's knowledge of your balance decays to loose bounds and never sharpens again unless you withdraw.</p>
        <p style={{ fontSize: 13 }}>
          Sent as <code>eosio.token::transfer</code> to <code>xprconf</code> with memo <code>conf:{"<you>"}</code>. The contract credits your pending box deterministically; no proof needed for a public amount.
        </p>
      </Card>
    </div>
  );
};
