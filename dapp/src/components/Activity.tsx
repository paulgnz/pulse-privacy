import type { ActivityItem, ConfState } from "../lib/client";
import { EXPLORER } from "../config";
import { ago, fmtUnits } from "../lib/format";
import { Card, Tag } from "./ui";

const LABEL: Record<ActivityItem["kind"], string> = {
  register: "registered key",
  deposit: "deposit",
  send: "sent",
  receive: "received",
  fold: "folded pending",
  withdraw: "withdraw",
};

export const Activity = ({ st, isMock }: { st: ConfState; isMock: boolean }) => (
  <Card>
    <div className="row between">
      <h2>Activity</h2>
      <span className="dim" style={{ fontSize: 13 }}>
        left: what you can read · right: what the chain shows
      </span>
    </div>
    {st.activity.length === 0 ? (
      <div className="empty">Nothing yet. Register, deposit, and send to see the two views side by side.</div>
    ) : (
      <table className="table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>when</th>
            <th>what</th>
            <th>with</th>
            <th className="num">you read</th>
            <th>on chain</th>
            <th>tx</th>
          </tr>
        </thead>
        <tbody>
          {st.activity.map((a) => (
            <tr key={a.id}>
              <td className="dim" style={{ whiteSpace: "nowrap" }}>
                {ago(a.ts)}
              </td>
              <td>{LABEL[a.kind]}</td>
              <td className="mono">{a.counterparty ?? (a.kind === "deposit" || a.kind === "withdraw" ? "eosio.token" : "")}</td>
              <td className={`num ${a.kind === "send" || a.kind === "withdraw" ? "" : a.kind === "receive" || a.kind === "deposit" ? "good" : "dim"}`}>
                {a.amount === undefined ? "" : (a.kind === "send" || a.kind === "withdraw" ? "−" : a.kind === "receive" || a.kind === "deposit" ? "+" : "") + fmtUnits(a.amount)}
              </td>
              <td>
                {a.onChain.public ? (
                  <span className="row" style={{ gap: 8 }}>
                    <Tag kind="public" />
                    {a.amount !== undefined ? <span className="mono warm">{fmtUnits(a.amount)} XPR</span> : null}
                  </span>
                ) : (
                  <span className="row" style={{ gap: 8 }}>
                    <Tag kind="hidden" />
                    <span className="mono faint" style={{ fontSize: 12 }}>
                      {a.onChain.ciphertext ?? "●●●●"}
                      {a.onChain.proof ? ` · proof ${a.onChain.proof}` : ""}
                    </span>
                  </span>
                )}
              </td>
              <td className="mono faint" style={{ fontSize: 12 }}>
                {a.onChain.txid ? (
                  isMock ? (
                    <span title="simulated">{a.onChain.txid.slice(0, 8)}… (mock)</span>
                  ) : (
                    <a href={`${EXPLORER}/tx/${a.onChain.txid}`} target="_blank" rel="noreferrer">
                      {a.onChain.txid.slice(0, 8)}…
                    </a>
                  )
                ) : (
                  ""
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </Card>
);
