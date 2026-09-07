import { useState } from "react";
import type { ConfState } from "../lib/client";
import type { EncryptionKeypair } from "../lib/crypto/types";
import { exportBlob } from "../lib/keys";
import { parseUnits, shortHex } from "../lib/format";
import { Field, Note } from "./ui";

export const Settings = ({
  actor,
  st,
  keypair,
  keyDerived,
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
  keyDerived: boolean;
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
  const [simFrom, setSimFrom] = useState(st.peers[0]?.name ?? "bob");
  const [simAmt, setSimAmt] = useState("1234");

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

  const payMe = `${location.origin}/?to=${actor}`;
  const [linkCopied, setLinkCopied] = useState(false);

  return (
    <>
      <section className="section">
        <h2>Encryption key</h2>
        {keyDerived ? (
          <p className="lede">Your key is derived from your wallet. Each time you sign in, one signature unlocks your boxes on this device; nothing is stored here.</p>
        ) : (
          <>
            <p className="lede">This is a saved key. It opens your boxes, is separate from your wallet's signing key, and stays in this browser.</p>
            <Note level="warn">
              <p>If you lose this key you cannot read your confidential balance, and you cannot build the proof that spends it. Export it and keep the file somewhere safe.</p>
            </Note>
          </>
        )}
        {keypair ? (
          <>
            <div className="kv">
              <span className="k">Public key</span>
              <span className="mono">{shortHex(keypair.pubkey, 12)}</span>
              <span className="k">On chain</span>
              <span>{st.registered ? `Registered for ${st.token.code}` : `Not registered for ${st.token.code} yet`}</span>
            </div>
            <div className="row" style={{ marginBottom: 20 }}>
              {!st.registered ? (
                <button className="btn private" onClick={() => run(onRegister, "Registered. Others can now pay you inside the contract.")} disabled={busy}>
                  Register for {st.token.code}
                </button>
              ) : null}
              {!keyDerived ? (
                <>
                  <button className="btn secondary" onClick={download}>
                    Export key file
                  </button>
                  <button className="textbtn" onClick={copy}>
                    {copied ? "Copied" : "Copy key"}
                  </button>
                </>
              ) : null}
            </div>
            <details>
              <summary>{keyDerived ? "Advanced: export a backup, or use a saved key" : "Replace or forget this key"}</summary>
              {keyDerived ? (
                <div className="row" style={{ marginBottom: 16 }}>
                  <button className="btn secondary" onClick={download}>
                    Export backup
                  </button>
                  <button className="textbtn" onClick={copy}>
                    {copied ? "Copied" : "Copy secret"}
                  </button>
                  <span className="small muted">Only needed if you move to a wallet whose signatures are not stable.</span>
                </div>
              ) : null}
              <Field label="Secret to import" hint="Replaces the stored key. Only do this to restore a backup of the key registered for this account.">
                <input className="mono" value={imp} onChange={(e) => setImp(e.target.value)} placeholder="0x" />
              </Field>
              <div className="row">
                <button className="btn secondary" onClick={() => run(() => onImportKey(imp), "Key imported.")} disabled={!imp}>
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
            </details>
          </>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 20 }}>
              <button className="btn private" onClick={() => run(onCreateKey, "Key created. Export it, then register.")} disabled={busy}>
                Create a key
              </button>
            </div>
            <Field label="Or import a secret you exported before">
              <input className="mono" value={imp} onChange={(e) => setImp(e.target.value)} placeholder="0x" />
            </Field>
            <div className="row">
              <button className="btn secondary" onClick={() => run(() => onImportKey(imp), "Key imported.")} disabled={!imp}>
                Import
              </button>
            </div>
          </>
        )}
        {msg ? (
          <div style={{ marginTop: 16 }}>
            <Note level={msg.ok ? "ok" : "error"}>{msg.text}</Note>
          </div>
        ) : null}
      </section>

      {st.registered ? (
        <section className="section">
          <h2>Pay-me link</h2>
          <p className="lede">Share this and the Send form opens with your name filled in. Anyone who has not set up yet is walked through it first.</p>
          <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
            <code className="mono payme">{payMe}</code>
            <button
              className="textbtn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(payMe);
                  setLinkCopied(true);
                  setTimeout(() => setLinkCopied(false), 2000);
                } catch { /* clipboard blocked: the link is selectable */ }
              }}
            >
              {linkCopied ? "Copied" : "Copy link"}
            </button>
          </div>
        </section>
      ) : null}

      {isMock ? (
        <section className="section">
          <h2>Simulation</h2>
          <p className="lede">This build simulates the contract and the crypto in your browser. Use these to exercise the flows and the withdrawal warning.</p>
          <Field label="Receive a simulated payment">
            <div className="row">
              <select value={simFrom} onChange={(e) => setSimFrom(e.target.value)} style={{ maxWidth: 160 }}>
                {st.peers.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input className="num" value={simAmt} onChange={(e) => setSimAmt(e.target.value)} style={{ maxWidth: 160 }} aria-label="Simulated amount" />
              <button className="btn secondary" onClick={() => run(() => onSimulateIncoming(simFrom, parseUnits(simAmt, st.token)), `${simFrom} paid you ${simAmt} ${st.token.code}. It is pending. Try withdrawing exactly that.`)} disabled={!st.registered || busy}>
                Receive
              </button>
            </div>
          </Field>
          <Field label="Other people's deposits and withdrawals" hint="Moves the pool activity counter the withdrawal check reads.">
            <div className="row">
              <button className="textbtn" onClick={() => run(() => onSimulatePool(1), "Added 1.")}>
                Add 1
              </button>
              <button className="textbtn" onClick={() => run(() => onSimulatePool(10), "Added 10.")}>
                Add 10
              </button>
            </div>
          </Field>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm("Reset the simulated pool? Your simulated balance and activity are wiped. Your key is kept.")) run(onResetMock, "Simulation reset.");
            }}
          >
            Reset simulation
          </button>
        </section>
      ) : null}
    </>
  );
};
