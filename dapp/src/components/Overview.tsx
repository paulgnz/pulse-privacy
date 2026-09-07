import { useState } from "react";
import type { ConfState } from "../lib/client";
import { fmtUnits, shortHex } from "../lib/format";
import { Card, Padlock, Stat, Tag } from "./ui";

export const Overview = ({
  st,
  publicBalance,
  escrow,
  onGo,
  onFold,
  busy,
}: {
  st: ConfState;
  publicBalance: bigint | null;
  escrow: bigint | null;
  onGo: (tab: string) => void;
  onFold: () => void;
  busy: boolean;
}) => {
  const [reveal, setReveal] = useState(true);
  const ct = st.balanceCiphertext?.lo.c;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="grid two">
        <Card accent="peri">
          <div className="row between">
            <h3>Confidential balance</h3>
            <Tag kind="hidden">ENCRYPTED ON CHAIN</Tag>
          </div>
          {!st.registered ? (
            <div className="stack">
              <p className="lede">You have not registered an encryption key with the contract yet.</p>
              <p>Registration publishes your encryption public key so others can pay you in the pool. It is one action and costs nothing but a little RAM.</p>
              <div>
                <button className="btn primary" onClick={() => onGo("settings")}>
                  Set up your key
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="lockbox">
                <div className="lock">
                  <Padlock size={28} open={reveal} />
                </div>
                {reveal ? (
                  <div className="value big">
                    {fmtUnits(st.balance)}
                    <span className="unit">XPR</span>
                  </div>
                ) : (
                  <div className="dots">
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                )}
                <div className="ct">{ct ? `box ${shortHex(ct, 8)}` : "no box yet"}</div>
              </div>
              <div className="row between" style={{ marginTop: 14 }}>
                <span className="dim" style={{ fontSize: 13 }}>
                  {reveal ? "What the chain shows is the box. This number is your decryption of it." : "This is all anyone else ever sees."}
                </span>
                <button className="btn ghost sm" onClick={() => setReveal(!reveal)}>
                  {reveal ? "Show as the chain sees it" : "Decrypt"}
                </button>
              </div>
              {st.pendingCount > 0 ? (
                <div className="notice notice" style={{ marginTop: 14 }}>
                  <div className="row between">
                    <span>
                      <b>{fmtUnits(st.pending)} XPR</b> <span className="dim">pending in {st.pendingCount} incoming transfer{st.pendingCount === 1 ? "" : "s"}</span>
                    </span>
                    <button className="btn sm" onClick={onFold} disabled={busy}>
                      Fold into balance
                    </button>
                  </div>
                  <p style={{ fontSize: 13, margin: "6px 0 0" }}>Incoming credits land in a separate box so nobody can invalidate a proof you are building. Folding happens automatically before your next send.</p>
                </div>
              ) : null}
              <div className="row" style={{ marginTop: 18, gap: 10 }}>
                <button className="btn primary" onClick={() => onGo("send")}>
                  Send
                </button>
                <button className="btn" onClick={() => onGo("deposit")}>
                  Deposit
                </button>
                <button className="btn ghost" onClick={() => onGo("withdraw")}>
                  Withdraw
                </button>
              </div>
            </>
          )}
        </Card>

        <div className="stack" style={{ gap: 18 }}>
          <Card accent="warm">
            <div className="row between">
              <h3>Public XPR</h3>
              <Tag kind="public">ON CHAIN · LIVE</Tag>
            </div>
            <div className="big">
              {publicBalance === null ? <span className="faint">…</span> : fmtUnits(publicBalance)}
              <span className="unit">XPR</span>
            </div>
            <p style={{ marginTop: 8 }}>Read from eosio.token on testnet. Everyone can see this number.</p>
          </Card>
          <Card>
            <h3>The pool</h3>
            <div className="grid three" style={{ gap: 12 }}>
              <Stat k="escrow, public" v={escrow === null ? "…" : fmtUnits(escrow, { trim: true })} className="warm" />
              <Stat k="edges since your last incoming" v={st.registered ? st.edgesSinceLastIncoming : "—"} />
              <Stat k="your transfer nonce" v={st.nonce.toString()} className="mono" />
            </div>
            <p style={{ marginTop: 12, fontSize: 13 }}>The escrow total is always public: a live proof of reserve. Only the pieces are hidden.</p>
          </Card>
        </div>
      </div>
    </div>
  );
};
