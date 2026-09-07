import { useEffect, useState } from "react";
import type { ConfState } from "../lib/client";
import { Amount } from "./Amount";
import { Deposit } from "./Deposit";
import { Send } from "./Send";
import { Line } from "./ui";
import { Withdraw } from "./Withdraw";

type Form = "send" | "deposit" | "withdraw" | null;
const REVEAL_KEY = "pulse-privacy/reveal";

export const Overview = ({
  st,
  publicBalance,
  onGo,
  onFold,
  onSend,
  onDeposit,
  onWithdraw,
  busy,
  refreshing = false,
}: {
  st: ConfState;
  publicBalance: bigint | null;
  onGo: (tab: string) => void;
  onFold: () => Promise<unknown>;
  onSend: (to: string, amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
  onDeposit: (amount: bigint) => Promise<string>;
  onWithdraw: (amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
  busy: boolean;
  /** a background refresh is running: animate the figures, do not disable anything */
  refreshing?: boolean;
}) => {
  const [revealed, setRevealed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(REVEAL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [form, setForm] = useState<Form>(() => {
    const q = new URLSearchParams(location.search).get("form");
    return q === "send" || q === "deposit" || q === "withdraw" ? q : null;
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(REVEAL_KEY, revealed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [revealed]);

  const toggle = (f: Form) => setForm((cur) => (cur === f ? null : f));

  if (!st.registered) {
    return (
      <section className="statement">
        <h2>Statement</h2>
        <Line label="Confidential balance" sub="no encryption key registered for this account yet" hero>
          <Amount hidden digits={9} size="big" />
        </Line>
        <Line label="Public XPR" sub="readable by anyone">
          {publicBalance === null ? <span className="muted">Loading</span> : <Amount value={publicBalance} size="mid" />}
        </Line>
        <p className="muted" style={{ marginTop: 20 }}>
          Registering publishes an encryption key so others can pay you inside the contract. It is one action and needs no change to your wallet.
        </p>
        <div className="actions">
          <button className="textbtn" onClick={() => onGo("settings")}>
            Set up your key
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="statement">
      <h2>Statement</h2>
      <Line label="Confidential balance" sub={revealed ? "decrypted on this device; the chain holds only the box" : "what everyone else sees"} hero>
        <Amount value={st.balance} hidden revealed={revealed} size="big" busy={busy || refreshing} />
        <button className="textbtn" onClick={() => setRevealed(!revealed)} aria-pressed={revealed}>
          {revealed ? "Hide" : "Reveal"}
        </button>
      </Line>
      {st.pendingCount > 0 ? (
        <Line
          label="Pending"
          sub={`${st.pendingCount} incoming ${st.pendingCount === 1 ? "transfer" : "transfers"} waiting in a separate box; folded before your next send`}
        >
          <Amount value={st.pending} hidden revealed={revealed} size="mid" sign="+" busy={busy || refreshing} />
          <button className="textbtn" onClick={() => onFold()} disabled={busy}>
            {busy ? "Folding" : "Fold in now"}
          </button>
        </Line>
      ) : null}
      <Line label="Public XPR" sub="readable by anyone">
        {publicBalance === null ? <span className="muted">Loading</span> : <Amount value={publicBalance} size="mid" />}
      </Line>

      <div className="actions" role="group" aria-label="Actions">
        <button className="textbtn" onClick={() => toggle("send")} aria-expanded={form === "send"}>
          Send
        </button>
        <button className="textbtn" onClick={() => toggle("deposit")} aria-expanded={form === "deposit"}>
          Deposit
        </button>
        <button className="textbtn" onClick={() => toggle("withdraw")} aria-expanded={form === "withdraw"}>
          Withdraw
        </button>
      </div>

      {form === "send" ? <Send st={st} onSend={onSend} busy={busy} onClose={() => setForm(null)} /> : null}
      {form === "deposit" ? <Deposit st={st} publicBalance={publicBalance} onDeposit={onDeposit} busy={busy} onClose={() => setForm(null)} /> : null}
      {form === "withdraw" ? <Withdraw st={st} onWithdraw={onWithdraw} busy={busy} onClose={() => setForm(null)} /> : null}
    </section>
  );
};
