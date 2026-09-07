import { useState } from "react";
import type { ConfState } from "../lib/client";
import type { EncryptionKeypair } from "../lib/crypto/types";
import { exportBlob } from "../lib/keys";
import { parseUnits, shortHex } from "../lib/format";
import { Card, Field, KeyGlyph, Notice, Tag } from "./ui";

export const Settings = ({
  actor,
  st,
  keypair,
  backendName,
  isMock,
  onCreateKey,
  onImportKey,
  onForgetKey,
  onRegister,
  onSimulateIncoming,
  onSimulatePool,
  onResetMock,
  busy,
}: {
  actor: string;
  st: ConfState;
  keypair: EncryptionKeypair | null;
  backendName: string;
  isMock: boolean;
  onCreateKey: () => Promise<void>;
  onImportKey: (secret: string) => Promise<void>;
  onForgetKey: () => void;
  onRegister: () => Promise<string>;
  onSimulateIncoming: (from: string, amount: bigint) => Promise<void>;
  onSimulatePool: (n: number) => Promise<void>;
  onResetMock: () => Promise<void>;
  busy: boolean;
}) => {
  const [imp, setImp] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [simFrom, setSimFrom] = useState("alice");
  const [simAmt, setSimAmt] = useState("1234.5679");

  const run = async (f: () => Promise<unknown>, okText: string) => {
    setMsg(null);
    try {
      await f();
      setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  const download = () => {
    if (!keypair) return;
    const blob = new Blob([exportBlob(actor, keypair)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `xpr-confidential-key-${actor}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copy = async () => {
    if (!keypair) return;
    await navigator.clipboard.writeText(exportBlob(actor, keypair));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="grid two">
      <div className="stack" style={{ gap: 18 }}>
        <Card accent="peri">
          <div className="row between">
            <h2>Encryption key</h2>
            <Tag kind="hidden">NEVER LEAVES THIS DEVICE</Tag>
          </div>
          <p>This key opens your boxes. It is separate from your WebAuth signing key and lives in this browser's storage.</p>
          <Notice level="warn" title="Losing it means losing the balance">
            Without this key you cannot read your confidential balance, and you cannot build the proof that spends it. Export it now and keep the file somewhere safe. In the production wallet it is derived from your seed; here, in the testnet dapp, it is yours to back up.
          </Notice>
          {keypair ? (
            <div className="stack" style={{ marginTop: 14 }}>
              <div className="row" style={{ gap: 10 }}>
                <KeyGlyph />
                <span className="mono dim" style={{ fontSize: 13 }}>
                  pubkey {shortHex(keypair.pubkey, 10)}
                </span>
                {st.registered ? <Tag kind="audit">REGISTERED</Tag> : <Tag kind="public">NOT REGISTERED</Tag>}
              </div>
              <div className="row">
                <button className="btn" onClick={download}>
                  Download key file
                </button>
                <button className="btn ghost" onClick={copy}>
                  {copied ? "Copied" : "Copy to clipboard"}
                </button>
                {!st.registered ? (
                  <button className="btn primary" onClick={() => run(onRegister, "Registered. Others can now pay you in the pool.")} disabled={busy}>
                    Register on chain
                  </button>
                ) : null}
              </div>
              <details>
                <summary className="dim" style={{ cursor: "pointer", fontSize: 13 }}>
                  Replace or forget this key
                </summary>
                <div className="stack" style={{ marginTop: 10 }}>
                  <Field label="Import a secret (hex)" hint="Replaces the stored key. Only do this to restore a backup of the key registered for this account.">
                    <input value={imp} onChange={(e) => setImp(e.target.value)} placeholder="0x…" />
                  </Field>
                  <div className="row">
                    <button className="btn" onClick={() => run(() => onImportKey(imp), "Key imported.")} disabled={!imp}>
                      Import
                    </button>
                    <button
                      className="btn danger"
                      onClick={() => {
                        if (confirm("Forget the encryption key on this device? Without a backup you lose access to the confidential balance.")) onForgetKey();
                      }}
                    >
                      Forget key on this device
                    </button>
                  </div>
                </div>
              </details>
            </div>
          ) : (
            <div className="stack" style={{ marginTop: 14 }}>
              <div className="row">
                <button className="btn primary" onClick={() => run(onCreateKey, "Key created. Export it, then register.")} disabled={busy}>
                  Create a new key
                </button>
              </div>
              <Field label="Or import a secret (hex)">
                <input value={imp} onChange={(e) => setImp(e.target.value)} placeholder="0x…" />
              </Field>
              <div>
                <button className="btn" onClick={() => run(() => onImportKey(imp), "Key imported.")} disabled={!imp}>
                  Import
                </button>
              </div>
            </div>
          )}
          {msg ? (
            <div style={{ marginTop: 14 }}>
              <Notice level={msg.ok ? "ok" : "bad"}>{msg.text}</Notice>
            </div>
          ) : null}
        </Card>

        <Card>
          <h3>Backend</h3>
          <p className="mono" style={{ fontSize: 13 }}>
            crypto: {backendName}
          </p>
          <p style={{ fontSize: 13 }}>
            The real prover (Baby Jubjub ElGamal + Groth16, T2) and the deployed token contract (T3) replace the mock behind the same interface, <code>src/lib/crypto/types.ts</code>. Nothing in this UI changes.
          </p>
        </Card>
      </div>

      {isMock ? (
        <Card accent="warm">
          <div className="row between">
            <h2>Mock controls</h2>
            <Tag kind="public">SIMULATED</Tag>
          </div>
          <p>The pool, the peers, and every transaction on this page are simulated in your browser. Use these to exercise the flows, including the edge warnings.</p>
          <div className="stack" style={{ marginTop: 14 }}>
            <Field label="Simulate an incoming payment">
              <div className="row">
                <select value={simFrom} onChange={(e) => setSimFrom(e.target.value)} style={{ maxWidth: 160 }}>
                  {st.peers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input value={simAmt} onChange={(e) => setSimAmt(e.target.value)} style={{ maxWidth: 180 }} />
                <button
                  className="btn"
                  onClick={() =>
                    run(() => onSimulateIncoming(simFrom, parseUnits(simAmt)), `${simFrom} paid you ${simAmt} XPR (pending). Now try withdrawing exactly that.`)
                  }
                  disabled={!st.registered || busy}
                >
                  Receive
                </button>
              </div>
            </Field>
            <Field label="Simulate pool activity" hint="Other people's deposits and withdrawals. Watch the edge indicator move.">
              <div className="row">
                <button className="btn ghost sm" onClick={() => run(() => onSimulatePool(1), "1 edge added.")}>
                  +1 edge
                </button>
                <button className="btn ghost sm" onClick={() => run(() => onSimulatePool(10), "10 edges added.")}>
                  +10 edges
                </button>
              </div>
            </Field>
            <div>
              <button
                className="btn danger sm"
                onClick={() => {
                  if (confirm("Reset the simulated pool? Your mock balance and activity are wiped. Your encryption key is kept.")) run(onResetMock, "Mock pool reset.");
                }}
              >
                Reset mock pool
              </button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
};
