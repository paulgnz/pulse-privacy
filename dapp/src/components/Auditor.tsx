import { useEffect, useState } from "react";
import type { AuditorRow } from "../lib/client";
import type { Hex } from "../lib/crypto/types";
import { fmtUnits } from "../lib/format";
import { Amount } from "./Amount";
import { Field, Line, Note } from "./ui";
import { XPR, type Token } from "../lib/token";

type Edges = { deposits: bigint; withdrawals: bigint; unclaimed: bigint; escrow: bigint; count: number };

const when = (ts: number) =>
  new Date(ts).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const Auditor = ({
  isMock,
  onOpen,
  onEdges,
  mockSecret,
  token = XPR,
}: {
  isMock: boolean;
  onOpen: (secret: Hex) => Promise<AuditorRow[]>;
  onEdges: () => Promise<Edges>;
  mockSecret: Hex | null;
  token?: Token;
}) => {
  const [key, setKey] = useState("");
  const [rows, setRows] = useState<AuditorRow[] | null>(null);
  const [edges, setEdges] = useState<Edges | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);

  // bars first, then the viewing key lifts them
  useEffect(() => {
    if (!rows) return;
    setOpened(false);
    const t = setTimeout(() => setOpened(true), 60);
    return () => clearTimeout(t);
  }, [rows]);

  const open = async () => {
    setErr(null);
    setBusy(true);
    try {
      const s = key.trim().toLowerCase();
      const [r, e] = await Promise.all([onOpen((s.startsWith("0x") ? s : `0x${s}`) as Hex), onEdges().catch(() => null)]);
      setRows(r);
      setEdges(e);
    } catch (e) {
      setRows(null);
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const total = rows?.reduce((s, r) => s + r.amount, 0n) ?? 0n;
  const backed = edges ? edges.escrow - edges.unclaimed === edges.deposits - edges.withdrawals : null;

  return (
    <>
      <section className="section">
        <h2>Auditor</h2>
        <p className="lede">Every confidential {token.code} transfer carries a copy the designated auditor can open. With the viewing key, every amount reads. The key can read; it cannot spend.</p>
        <Field
          label="Viewing key"
          hint={
            isMock && mockSecret ? (
              <>
                Simulation key:{" "}
                <button className="textbtn" onClick={() => setKey(mockSecret)}>
                  use it
                </button>
              </>
            ) : (
              "Held by the supervisor. Paste it here to open the ledger on this device."
            )
          }
        >
          <input className="mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="0x" />
        </Field>
        <div className="row" style={{ marginBottom: 16 }}>
          <button className="btn" onClick={open} disabled={!key || busy}>
            {busy ? "Opening" : "Open the ledger"}
          </button>
        </div>
        {err ? <Note level="error">Could not open the ledger. {err}</Note> : null}
      </section>

      {rows ? (
        <section className="section">
          <h2>Transfers</h2>
          <p className="lede">
            {rows.length} {rows.length === 1 ? "transfer" : "transfers"}, {fmtUnits(total, token)} {token.code} in total{isMock ? ", simulated" : ""}.
          </p>
          {rows.length === 0 ? (
            <div className="empty">No confidential transfers yet.</div>
          ) : (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Transfer</th>
                  <th className="amount">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="when">{when(r.ts)}</td>
                    <td className="what">
                      {r.from} to {r.to}
                      <span className="meta">
                        Box {r.ciphertext}
                        {r.block ? `, block ${r.block.toLocaleString("en-US")}` : ""}
                      </span>
                    </td>
                    <td className="amount">
                      <Amount value={r.amount} hidden revealed={opened} tone="auditor" token={token} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      {rows && edges && !isMock ? (
        <section className="section">
          <h2>Reconciliation</h2>
          <p className="lede">Deposits and withdrawals are public, so the escrow can be checked by anyone.</p>
          <Line label="Deposits">
            <Amount value={edges.deposits} size="mid" token={token} />
          </Line>
          <Line label="Withdrawals">
            <Amount value={edges.withdrawals} size="mid" sign="−" token={token} />
          </Line>
          <Line label="Claims outstanding">
            <Amount value={edges.deposits - edges.withdrawals} size="mid" token={token} />
          </Line>
          <Line label="Escrow balance" sub={edges.unclaimed > 0n ? `includes ${fmtUnits(edges.unclaimed, token)} ${token.code} from plain transfers with no claim` : undefined}>
            <Amount value={edges.escrow} size="mid" token={token} />
          </Line>
          <p className={`small ${backed ? "" : ""}`} style={{ marginTop: 14, color: backed ? "var(--auditor)" : "var(--error)" }}>
            {backed ? "Escrow equals deposits minus withdrawals. The pool is fully backed." : "Escrow does not equal deposits minus withdrawals over the indexed history."}
          </p>
        </section>
      ) : null}
    </>
  );
};
