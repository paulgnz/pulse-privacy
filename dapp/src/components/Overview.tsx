import { useEffect, useState } from "react";
import type { ConfState } from "../lib/client";
import { Amount } from "./Amount";
import { Deposit } from "./Deposit";
import { Send } from "./Send";
import { Line, Note } from "./ui";
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
  onRegister,
  hasKey = false,
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
  /** register the encryption key for this token (already set up for another token) */
  onRegister?: () => Promise<unknown>;
  hasKey?: boolean;
}) => {
  const [revealed, setRevealed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(REVEAL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [notice, setNotice] = useState<string | null>(null);
  const done = (msg: string) => {
    setNotice(msg);
    setForm(null);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };
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

  const T = st.token;
  if (!st.registered) {
    return (
      <section className="statement">
        <h2>Statement</h2>
        <Line label={`Confidential ${T.code}`} sub={`not registered for ${T.code} yet`} hero>
          <Amount hidden digits={9} size="big" token={T} />
        </Line>
        <Line label={`Public ${T.code}`} sub="readable by anyone">
          {publicBalance === null ? <span className="muted">Loading</span> : <Amount value={publicBalance} size="mid" token={T} />}
        </Line>
        <p className="muted" style={{ marginTop: 20 }}>
          Registering publishes your encryption key for {T.code} so others can pay you {T.code} inside the contract. Same key, one signature.
        </p>
        <div className="actions">
          {hasKey && onRegister ? (
            <button className="btn private" onClick={() => onRegister()} disabled={busy}>
              {busy ? "Registering" : `Register for ${T.code}`}
            </button>
          ) : (
            <button className="textbtn" onClick={() => onGo("settings")}>
              Set up your key
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="statement">
      <h2>Statement</h2>
      {notice ? (
        <Note level="ok">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
            <span>{notice}</span>
            <button className="textbtn quiet" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        </Note>
      ) : null}
      <Line label="Confidential balance" sub={revealed ? "decrypted on this device; the chain holds only the box" : "what everyone else sees"} hero>
        <Amount value={st.balance} hidden revealed={revealed} size="big" busy={busy || refreshing} token={T} />
        <button className="textbtn" onClick={() => setRevealed(!revealed)} aria-pressed={revealed}>
          {revealed ? "Hide" : "Reveal"}
        </button>
      </Line>
      {st.pendingCount > 0 ? (
        <Line
          label="Pending"
          sub={`${st.pendingCount} incoming ${st.pendingCount === 1 ? "transfer" : "transfers"} waiting in a separate box; folded before your next send`}
        >
          <Amount value={st.pending} hidden revealed={revealed} size="mid" sign="+" busy={busy || refreshing} token={T} />
          <button className="textbtn" onClick={() => onFold()} disabled={busy}>
            {busy ? "Folding" : "Fold in now"}
          </button>
        </Line>
      ) : null}
      <Line label={`Public ${T.code}`} sub="readable by anyone">
        {publicBalance === null ? <span className="muted">Loading</span> : <Amount value={publicBalance} size="mid" token={T} />}
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

      {form === "send" ? <Send st={st} onSend={onSend} busy={busy} onClose={() => setForm(null)} onDone={done} /> : null}
      {form === "deposit" ? <Deposit st={st} publicBalance={publicBalance} onDeposit={onDeposit} busy={busy} onClose={() => setForm(null)} onDone={done} /> : null}
      {form === "withdraw" ? <Withdraw st={st} onWithdraw={onWithdraw} busy={busy} onClose={() => setForm(null)} onDone={done} /> : null}
    </section>
  );
};
