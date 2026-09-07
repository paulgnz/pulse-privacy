import { useState } from "react";
import type { AuditorRow } from "../lib/client";
import type { Hex } from "../lib/crypto/types";
import { ago, fmtUnits } from "../lib/format";
import { Card, Field, KeyGlyph, Notice, Tag } from "./ui";

type Edges = { deposits: bigint; withdrawals: bigint; unclaimed: bigint; escrow: bigint; count: number };

export const Auditor = ({
  isMock,
  onOpen,
  onEdges,
  mockSecret,
}: {
  isMock: boolean;
  onOpen: (secret: Hex) => Promise<AuditorRow[]>;
  onEdges: () => Promise<Edges>;
  mockSecret: Hex | null;
}) => {
  const [key, setKey] = useState("");
  const [rows, setRows] = useState<AuditorRow[] | null>(null);
  const [edges, setEdges] = useState<Edges | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="grid two">
        <Card accent="good">
          <div className="row between">
            <h2>Auditor mode</h2>
            <Tag kind="audit">VIEWING KEY</Tag>
          </div>
          <p>Every transfer in the pool carries a handle for the designated auditor. With the viewing key, every amount decrypts. Without it, nothing does. The key can read; it cannot spend.</p>
          <div className="stack" style={{ marginTop: 14 }}>
            <Field label="Viewing key (secret, hex)" hint={isMock && mockSecret ? <span>mock viewing key: <code onClick={() => setKey(mockSecret)} style={{ cursor: "pointer" }}>{mockSecret}</code> (click to use)</span> : "held by the supervisor, offline"}>
              <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="0x…" />
            </Field>
            <div className="row">
              <button className="btn primary" onClick={open} disabled={!key || busy}>
                <span className="row" style={{ gap: 8 }}>
                  <KeyGlyph size={16} color="#0b101f" /> {busy ? "Decrypting…" : "Open the ledger"}
                </span>
              </button>
            </div>
            {err ? <Notice level="bad">{err}</Notice> : null}
          </div>
        </Card>
        <Card>
          <h3>What the auditor gets</h3>
          <p>A complete, decrypted ledger: sender, receiver, amount, block. Deposits and withdrawals are public anyway. Reconciling the decrypted balances to the escrow gives a live proof of reserve.</p>
          <p style={{ fontSize: 13 }}>Key rotation appends a new auditor public key on chain; transfers after that block are readable by the new key, earlier ones by the old one. The supervisor keeps both.</p>
        </Card>
      </div>

      {rows && edges && !isMock ? (
        <Card>
          <div className="row between">
            <h3>Reconciliation (public edges vs escrow)</h3>
            <Tag kind="public">PROOF OF RESERVE</Tag>
          </div>
          <div className="grid four" style={{ marginTop: 10 }}>
            <div className="stat"><div className="v warm">{fmtUnits(edges.deposits)}</div><div className="k">deposits (public)</div></div>
            <div className="stat"><div className="v warm">{fmtUnits(edges.withdrawals)}</div><div className="k">withdrawals (public)</div></div>
            <div className="stat"><div className="v">{fmtUnits(edges.deposits - edges.withdrawals)}</div><div className="k">claims outstanding</div></div>
            <div className="stat"><div className={`v ${edges.escrow - edges.unclaimed === edges.deposits - edges.withdrawals ? "good" : "bad"}`}>{fmtUnits(edges.escrow)}</div><div className="k">escrow balance{edges.unclaimed > 0n ? ` (incl. ${fmtUnits(edges.unclaimed)} unclaimed plain transfers)` : ""}</div></div>
          </div>
          <p style={{ fontSize: 13, marginTop: 10 }}>
            {edges.escrow - edges.unclaimed === edges.deposits - edges.withdrawals ? "Escrow equals deposits minus withdrawals. The pool is fully backed." : "Escrow does not equal deposits minus withdrawals over the indexed history window."}
          </p>
        </Card>
      ) : null}

      {rows ? (
        <Card accent="good">
          <div className="row between">
            <h3>Decrypted ledger {isMock ? "(simulated pool)" : ""}</h3>
            <span className="mono dim" style={{ fontSize: 13 }}>
              {rows.length} transfers · {fmtUnits(total)} XPR total
            </span>
          </div>
          {rows.length === 0 ? (
            <div className="empty">No confidential transfers in the pool yet.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>when</th>
                  <th>block</th>
                  <th>from</th>
                  <th>to</th>
                  <th>ciphertext</th>
                  <th className="num">amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="dim">{ago(r.ts)}</td>
                    <td className="mono faint">{r.block?.toLocaleString("en-US") ?? ""}</td>
                    <td className="mono">{r.from}</td>
                    <td className="mono">{r.to}</td>
                    <td className="mono faint" style={{ fontSize: 12 }}>
                      {r.ciphertext}
                    </td>
                    <td className="num good">{fmtUnits(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}
    </div>
  );
};
