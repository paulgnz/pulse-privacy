import { useState } from "react";
import type { ActivityItem, ConfState } from "../lib/client";
import { EXPLORER } from "../config";
import { Amount } from "./Amount";

const what = (a: ActivityItem): string => {
  switch (a.kind) {
    case "register":
      return "Registered encryption key";
    case "deposit":
      return "Deposit";
    case "send":
      return `Sent to ${a.counterparty ?? ""}`;
    case "receive":
      return `Received from ${a.counterparty ?? ""}`;
    case "fold":
      return "Added incoming payments to balance";
    case "withdraw":
      return "Withdrawal";
  }
};

const when = (ts: number) =>
  new Date(ts).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const Activity = ({ st, isMock }: { st: ConfState; isMock: boolean }) => {
  const [revealed, setRevealed] = useState(true);
  const rows = st.activity;
  return (
    <section className="section">
      <h2>Activity</h2>
      <p className="muted small">Confidential {st.token.code}</p>
      <p className="lede">Each line is what the chain recorded, across every token. Amounts you can read are shown because this device holds your key.</p>
      {rows.length === 0 ? (
        <div className="empty">{st.historyLoaded === false ? "Loading activity" : "No activity yet. Deposit to start."}</div>
      ) : (
        <>
          <div className="legend">
            <span>
              <span className="redact" /> hidden on chain
            </span>
            <button className="textbtn" onClick={() => setRevealed(!revealed)} aria-pressed={revealed}>
              {revealed ? "Hide what only you can read" : "Show what only you can read"}
            </button>
          </div>
          <table className="ledger">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th className="amount">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const hidden = !a.onChain.public;
                const sign = a.kind === "send" || a.kind === "withdraw" ? "−" : a.kind === "receive" || a.kind === "deposit" ? "+" : undefined;
                const hasAmount = a.amount !== undefined;
                return (
                  <tr key={a.id}>
                    <td className="when">{when(a.ts)}</td>
                    <td className="what">
                      {what(a)}
                      <span className="meta">
                        {a.onChain.public ? "Public" : "Box"}
                        {a.onChain.proof ? `, proof ${a.onChain.proof}` : ""}
                        {a.confirming ? <span className="muted">confirming</span> : null}
                        {a.unverified ? <span className="muted">, not yet checked against the chain</span> : null}
                        {a.onChain.txid ? (
                          <>
                            {", "}
                            {isMock ? <span title="simulated">{a.onChain.txid.slice(0, 8)} (mock)</span> : <a href={`${EXPLORER}/tx/${a.onChain.txid}`} target="_blank" rel="noreferrer">{a.onChain.txid.slice(0, 8)}</a>}
                          </>
                        ) : null}
                      </span>
                    </td>
                    <td className="amount">
                      {a.kind === "fold" || a.kind === "register" ? (
                        <span className="muted">{a.kind === "fold" && hasAmount && revealed ? <Amount value={a.amount} hidden revealed unit={false} token={a.token ?? st.token} /> : ""}</span>
                      ) : (
                        <>
                          <Amount value={a.amount} hidden={hidden} revealed={revealed && hasAmount} sign={sign} digits={hasAmount ? undefined : 9} token={a.token ?? st.token} />
                          {hidden && hasAmount && revealed ? <span className="onlyyou">only you can read this</span> : null}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
};
