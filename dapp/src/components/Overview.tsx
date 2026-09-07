import { useEffect, useState } from "react";
import type { ConfState } from "../lib/client";
import { fmtUnits } from "../lib/format";
import { EXPLORER } from "../config";
import { Amount } from "./Amount";
import { Deposit } from "./Deposit";
import { Send } from "./Send";
import { Explain, Line, Note, TokenIcon } from "./ui";
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
  backupNeeded = false,
  onStoreRecovery,
  onWithdrawToken,
}: {
  /** the token the forms act on */
  st: ConfState;
  /** every configured token, in order; the statement shows them all together */
  figures: TokenFigures[];
  onGo: (tab: string) => void;
  onFold: (code: string) => Promise<unknown>;
  onSend: (to: string, amount: bigint, onProgress: (f: number, s: string) => void) => Promise<string>;
  onDeposit: (amount: bigint) => Promise<string>;
  onWithdraw: (amount: bigint, onProgress: (f: number, s: string) => void, close?: boolean) => Promise<string>;
  busy: boolean;
  /** a background refresh is running: animate the figures, do not disable anything */
  refreshing?: boolean;
  /** register the encryption key for a token (already set up for another one) */
  onRegister?: (code: string) => Promise<unknown>;
  hasKey?: boolean;
  /** a saved key with no recovery copy on chain and no export yet: losing this browser loses the funds */
  backupNeeded?: boolean;
  onStoreRecovery?: () => Promise<unknown>;
  onWithdrawToken?: (code: string, amount: bigint, onProgress: (f: number, s: string) => void, close?: boolean) => Promise<string>;
  tokens?: { code: string }[];
  onSelectToken?: (code: string) => void;
}) => {
  const [revealed, setRevealed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(REVEAL_KEY) === "1"; // hidden by default; remembered in this browser
    } catch {
      return false;
    }
  });
  const [notice, setNotice] = useState<{ msg: string; txid?: string } | null>(null);
  const done = (msg: string, txid?: string) => {
    setNotice({ msg, txid: txid && txid !== "mock" ? txid : undefined });
    setForm(null);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const [form, setForm] = useState<Form>(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get("form") ?? (params.get("to") ? "send" : null);
    return q === "send" || q === "deposit" || q === "withdraw" ? q : null;
  });
  useEffect(() => {
    try {
      localStorage.setItem(REVEAL_KEY, revealed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [revealed]);

  const toggle = (f: Form) => {
    setForm((cur) => (cur === f ? null : f));
    // on phones the actions are pinned to the bottom; bring the form that opens beneath them into view
    if (typeof window !== "undefined" && window.innerWidth <= 600) {
      setTimeout(() => document.querySelector(".statement .form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  };
  const [depositPrefill, setDepositPrefill] = useState<string | undefined>(undefined);
  const depositFirst = (amount: bigint) => {
    setDepositPrefill(fmtUnits(amount, st.token, { trim: true }).replace(/,/g, ""));
    setForm("deposit");
  };

  const registered = figures.filter((f) => f.st.registered);
  const unregistered = figures.filter((f) => !f.st.registered);
  const anyRegistered = registered.length > 0;

  return (
    <section className="statement">
      <h2>Statement</h2>
      {backupNeeded ? (
        <Note level="warn">
          <p>
            <b>Your encryption key is only in this browser.</b> If it is lost, nobody can read or spend this balance. Keep an encrypted recovery copy with the XPR Network committee (one signature), or export the key file in Settings.
          </p>
          <div className="row" style={{ gap: 14 }}>
            {onStoreRecovery ? (
              <button className="btn private small" onClick={() => onStoreRecovery()} disabled={busy}>
                {busy ? "Storing" : "Keep a recovery copy"}
              </button>
            ) : null}
            <button className="textbtn" onClick={() => onGo("settings")}>Export the key file</button>
          </div>
        </Note>
      ) : null}
      {notice ? (
        <Note level="ok">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
            <span>
              {notice.msg}
              {notice.txid ? (
                <>
                  {" "}
                  <a href={`${EXPLORER}/transaction/${notice.txid}`} target="_blank" rel="noreferrer">Transaction {notice.txid.slice(0, 12)}</a>.
                </>
              ) : null}
            </span>
            <button className="textbtn quiet" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        </Note>
      ) : null}

      <div className="group private">
        <h3>
          Confidential balance
          <span className="sub">{revealed ? "Shown on this device only. The chain holds encrypted boxes." : "Hidden by default. Reveal shows it on this device only."}</span>
        </h3>
        <button className="textbtn" onClick={() => setRevealed(!revealed)} aria-pressed={revealed}>
          {revealed ? "Hide" : "Reveal"}
        </button>
      </div>
      {registered.map((f) => {
        const T = f.st.token;
        const sweeping = busy || refreshing || !!f.loading;
        return (
          <div key={T.code}>
            <Line label={<span className="tok"><TokenIcon code={T.code} />{T.code}</span>} hero>
              <Amount value={f.st.balance} hidden revealed={revealed} size="big" digits={9} busy={sweeping} token={T} unit={false} />
            </Line>
            {f.st.pendingCount > 0 ? (
              <Line
                label={`Incoming ${T.code}`}
                sub={
                  <>
                    {f.st.pendingCount} {f.st.pendingCount === 1 ? "payment" : "payments"} received, not yet added to your balance
                    <Explain label="Why is this separate?">
                      <p>
                        Payments to you land in a separate incoming box rather than straight into your balance. That keeps
                        your balance under your control alone: a payment you are in the middle of making can never be broken
                        by someone paying you at the same moment, and nobody can spam your balance to interfere with it.
                      </p>
                      <p>
                        "Add to balance" moves the incoming box into your balance. It is one quick signature and nothing
                        leaves the contract. If you skip it, the app does it for you when you next send more than your
                        balance holds, so you never lose anything by waiting.
                      </p>
                    </Explain>
                  </>
                }
              >
                <Amount value={f.st.pending} hidden revealed={revealed} size="mid" digits={7} sign="+" busy={sweeping} token={T} unit={false} />
                <button className="btn private small" onClick={() => onFold(T.code)} disabled={busy}>
                  {busy ? "Adding" : "Add to balance"}
                </button>
              </Line>
            ) : null}
          </div>
        );
      })}

      {unregistered.map((f) => {
        const T = f.st.token;
        return (
          <Line key={T.code} label={<span className="tok"><TokenIcon code={T.code} />{T.code}</span>} sub={f.loading ? "checking" : `not registered for ${T.code} yet`} hero={!anyRegistered}>
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

      <div className="group public">
        <h3>
          Wallet balance
          <span className="sub">Public. Anyone can read it.</span>
        </h3>
      </div>
      {figures.map((f) => {
        const T = f.st.token;
        return (
          <Line key={T.code} label={<span className="tok"><TokenIcon code={T.code} />{T.code}</span>}>
            {f.publicBalance === null ? <span className="muted">Loading</span> : <Amount value={f.publicBalance} size="mid" token={T} unit={false} />}
          </Line>
        );
      })}

      {anyRegistered ? (
        <>
          <div className="actions" role="group" aria-label="Actions">
            <button className="btn" onClick={() => toggle("send")} aria-expanded={form === "send"}>
              Send
            </button>
            <button className="btn secondary" onClick={() => toggle("deposit")} aria-expanded={form === "deposit"}>
              Deposit
            </button>
            <button className="btn secondary" onClick={() => toggle("withdraw")} aria-expanded={form === "withdraw"}>
              Withdraw
            </button>
          </div>

          {form === "send" ? <Send st={st} onSend={onSend} busy={busy} onClose={() => setForm(null)} onDone={done} tokens={tokens} onSelectToken={onSelectToken} publicBalance={figures.find((f) => f.st.token.code === st.token.code)?.publicBalance ?? null} onDepositFirst={depositFirst} /> : null}
          {form === "deposit" ? <Deposit key={depositPrefill ?? "deposit"} st={st} publicBalance={figures.find((f) => f.st.token.code === st.token.code)?.publicBalance ?? null} onDeposit={onDeposit} busy={busy} onClose={() => { setForm(null); setDepositPrefill(undefined); }} onDone={(m, t) => { setDepositPrefill(undefined); done(m, t); }} tokens={tokens} onSelectToken={onSelectToken} initialAmount={depositPrefill} /> : null}
          {form === "withdraw" ? <Withdraw st={st} onWithdraw={onWithdraw} busy={busy} onClose={() => setForm(null)} onDone={done} tokens={tokens} onSelectToken={onSelectToken} allTokens={figures.filter((f) => f.st.registered)} onWithdrawAll={onWithdrawToken} /> : null}
        </>
      ) : (
        <p className="muted" style={{ marginTop: 20 }}>
          Registering publishes your encryption key so others can pay you inside the contract. Same key, one signature.
        </p>
      )}
    </section>
  );
};
