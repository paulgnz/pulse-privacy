import { useEffect, useState } from "react";
import type { ConfState } from "../lib/client";
import { Amount } from "./Amount";
import { Deposit } from "./Deposit";
import { Send } from "./Send";
import { Line, Note, TokenIcon } from "./ui";
import { Withdraw } from "./Withdraw";

type Form = "send" | "deposit" | "withdraw" | null;
const REVEAL_KEY = "pulse-privacy/reveal";

/** One token's figures on the statement: the current token's state or a background-loaded one. */
export interface TokenFigures {
  st: ConfState;
  publicBalance: bigint | null;
  /** still loading in the background (figures sweep) */
  loading?: boolean;
}

export const Overview = ({
  st,
  figures,
  onGo,
  onFold,
  onSend,
  onDeposit,
  onWithdraw,
  busy,
  refreshing = false,
  tokens,
  onSelectToken,
  onRegister,
  hasKey = false,
}: {
  /** the token the forms act on */
  st: ConfState;
  /** every configured token, in order; the statement shows them all together */
  figures: TokenFigures[];
  onGo: (tab: string) => void;
  onFold: (code: string) => Promise<unknown>;
  onSend: (to: string, amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
  onDeposit: (amount: bigint) => Promise<string>;
  onWithdraw: (amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
  busy: boolean;
  /** a background refresh is running: animate the figures, do not disable anything */
  refreshing?: boolean;
  /** register the encryption key for a token (already set up for another one) */
  onRegister?: (code: string) => Promise<unknown>;
  hasKey?: boolean;
  tokens?: { code: string }[];
  onSelectToken?: (code: string) => void;
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

  const registered = figures.filter((f) => f.st.registered);
  const unregistered = figures.filter((f) => !f.st.registered);
  const anyRegistered = registered.length > 0;

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

      {registered.map((f, i) => {
        const T = f.st.token;
        const sweeping = busy || refreshing || !!f.loading;
        return (
          <div key={T.code}>
            <Line
              label={<span className="tok"><TokenIcon code={T.code} />Confidential {T.code}</span>}
              sub={i === 0 ? (revealed ? "decrypted on this device; the chain holds only the box" : "what everyone else sees") : undefined}
              hero={i === 0}
            >
              <Amount value={f.st.balance} hidden revealed={revealed} size={i === 0 ? "big" : "mid"} busy={sweeping} token={T} />
              {i === 0 ? (
                <button className="textbtn" onClick={() => setRevealed(!revealed)} aria-pressed={revealed}>
                  {revealed ? "Hide" : "Reveal"}
                </button>
              ) : null}
            </Line>
            {f.st.pendingCount > 0 ? (
              <Line
                label={`Pending ${T.code}`}
                sub={`${f.st.pendingCount} incoming ${f.st.pendingCount === 1 ? "transfer" : "transfers"} waiting in a separate box; folded before your next send`}
              >
                <Amount value={f.st.pending} hidden revealed={revealed} size="mid" sign="+" busy={sweeping} token={T} />
                <button className="textbtn" onClick={() => onFold(T.code)} disabled={busy}>
                  {busy ? "Folding" : "Fold in now"}
                </button>
              </Line>
            ) : null}
          </div>
        );
      })}

      {unregistered.map((f) => {
        const T = f.st.token;
        return (
          <Line key={T.code} label={<span className="tok"><TokenIcon code={T.code} />Confidential {T.code}</span>} sub={f.loading ? "checking" : `not registered for ${T.code} yet`} hero={!anyRegistered}>
            <Amount hidden digits={9} size={anyRegistered ? "mid" : "big"} busy={!!f.loading} token={T} />
            {f.loading ? null : hasKey && onRegister ? (
              <button className="textbtn" onClick={() => onRegister(T.code)} disabled={busy}>
                {busy ? "Registering" : `Register for ${T.code}`}
              </button>
            ) : (
              <button className="textbtn" onClick={() => onGo("settings")}>
                Set up your key
              </button>
            )}
          </Line>
        );
      })}

      {figures.map((f) => {
        const T = f.st.token;
        return (
          <Line key={T.code} label={<span className="tok"><TokenIcon code={T.code} />Public {T.code}</span>} sub="readable by anyone">
            {f.publicBalance === null ? <span className="muted">Loading</span> : <Amount value={f.publicBalance} size="mid" token={T} />}
          </Line>
        );
      })}

      {anyRegistered ? (
        <>
          <div className="actions" role="group" aria-label="Actions">
            <button className="btn secondary" onClick={() => toggle("send")} aria-expanded={form === "send"}>
              Send
            </button>
            <button className="btn secondary" onClick={() => toggle("deposit")} aria-expanded={form === "deposit"}>
              Deposit
            </button>
            <button className="btn secondary" onClick={() => toggle("withdraw")} aria-expanded={form === "withdraw"}>
              Withdraw
            </button>
          </div>

          {form === "send" ? <Send st={st} onSend={onSend} busy={busy} onClose={() => setForm(null)} onDone={done} tokens={tokens} onSelectToken={onSelectToken} /> : null}
          {form === "deposit" ? <Deposit st={st} publicBalance={figures.find((f) => f.st.token.code === st.token.code)?.publicBalance ?? null} onDeposit={onDeposit} busy={busy} onClose={() => setForm(null)} onDone={done} tokens={tokens} onSelectToken={onSelectToken} /> : null}
          {form === "withdraw" ? <Withdraw st={st} onWithdraw={onWithdraw} busy={busy} onClose={() => setForm(null)} onDone={done} tokens={tokens} onSelectToken={onSelectToken} /> : null}
        </>
      ) : (
        <p className="muted" style={{ marginTop: 20 }}>
          Registering publishes your encryption key so others can pay you inside the contract. Same key, one signature.
        </p>
      )}
    </section>
  );
};
