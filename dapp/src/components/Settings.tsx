import { useEffect, useState } from "react";
import type { ConfState } from "../lib/client";
import type { EncryptionKeypair } from "../lib/crypto/types";
import { MIN_PASSPHRASE, exportBlob, generatePassphrase, isBackedUp, passphraseProblem } from "../lib/keys";
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
  recoveryOnChain = null,
  onStoreRecovery,
  onExported,
  backupOnChain = null,
  onStoreBackup,
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
  /** saved keys: null = unknown/not applicable, true = an encrypted copy is on chain */
  recoveryOnChain?: boolean | null;
  onStoreRecovery?: () => Promise<unknown>;
  onExported?: () => void;
  backupOnChain?: boolean | null;
  onStoreBackup?: (passphrase: string) => Promise<unknown>;
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
    onExported?.();
    setFileSaved(true);
    if (!keypair) return;
    const blob = new Blob([exportBlob(actor, keypair)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `xpr-confidential-key-${actor}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copy = async () => {
    onExported?.();
    setFileSaved(true);
    if (!keypair) return;
    await navigator.clipboard.writeText(exportBlob(actor, keypair));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const payMe = `${location.origin}/?to=${actor}`;
  // the recovery-phrase form: open at once when there is no phrase yet, behind "Change" when there is
  const [showPhrase, setShowPhrase] = useState(() => backupOnChain !== true);
  const [customPass, setCustomPass] = useState(false);
  const [pass, setPass] = useState(() => (backupOnChain === true ? "" : generatePassphrase()));
  const [passCopied, setPassCopied] = useState(false);
  const [fileSaved, setFileSaved] = useState(() => isBackedUp(actor));
  const anyBackup = backupOnChain === true || recoveryOnChain === true || fileSaved;
  const [linkCopied, setLinkCopied] = useState(false);
  // the chain answer can arrive after this page opened: fold the form away once a phrase is known to exist
  useEffect(() => {
    if (backupOnChain === true) { setShowPhrase(false); setPass(""); setPassCopied(false); }
  }, [backupOnChain]);
  const copyPhrase = async () => {
    try {
      await navigator.clipboard.writeText(pass);
      setPassCopied(true);
    } catch { /* clipboard blocked: the words are selectable */ }
  };
  const savePhrase = () =>
    run(
      () => onStoreBackup!(pass).then(() => { setPass(""); setPassCopied(false); setCustomPass(false); setShowPhrase(false); }),
      "Recovery phrase saved. Keep the words: they are not stored anywhere.",
    );

  return (
    <>
      <section className="section">
        <h2>{keypair && !keyDerived ? "Recovery" : "Encryption key"}</h2>
        {keyDerived ? (
          <p className="lede">Your key is derived from your wallet. Each time you sign in, one signature unlocks your boxes on this device; nothing is stored here. It stays the same as long as your wallet's signing key does.</p>
        ) : keypair ? (
          <>
            <p className={`recovery-status ${anyBackup ? "ok" : "warn"}`}>{anyBackup ? "Recovery is set up." : "Recovery is not set up."}</p>
            <p className="lede">{anyBackup ? "Your usable key is stored in this browser. The recovery options below help you access your confidential funds on another device." : "Your usable key is stored in this browser. Set up recovery so you can reach your confidential funds on another device."}</p>
            <details className="explain" style={{ marginBottom: 18 }}>
              <summary>Learn more</summary>
              <div className="body">
                <p>Your wallet signs with a passkey, so this app keeps a saved key for you instead of deriving one from a signature. The key reads your confidential balance and builds the proofs that spend it. It is separate from your wallet's signing key, and spending always needs your wallet as well. Any one of the three methods below gets the key back on another device.</p>
              </div>
            </details>
          </>
        ) : null}
        {keypair ? (
          <>
            {msg ? (
              <div style={{ margin: "4px 0 18px" }}>
                <Note level={msg.ok ? "ok" : "error"}>{msg.text}</Note>
              </div>
            ) : null}
            {!st.registered ? (
              <div className="row" style={{ marginBottom: 20 }}>
                <button className="btn private" onClick={() => run(onRegister, "Registered. Others can now pay you inside the contract.")} disabled={busy}>
                  Register for {st.token.code}
                </button>
              </div>
            ) : null}

            {!keyDerived ? (
              <div className="methods">
                <div className="method">
                  <div className="what"><b>Recovery phrase</b><span>Seven words that restore the key on any device.</span></div>
                  <span className={`status ${backupOnChain ? "yes" : "no"}`}>{backupOnChain ? "Set" : "Not set"}</span>
                  {onStoreBackup && !showPhrase ? (
                    <button className="textbtn" onClick={() => { setPass(generatePassphrase()); setCustomPass(false); setPassCopied(false); setShowPhrase(true); }}>
                      {backupOnChain ? "Change" : "Set up"}
                    </button>
                  ) : <span />}
                </div>
                {onStoreBackup && showPhrase ? (
                  <div className="method-form">
                    {customPass ? (
                      <>
                        <Field className="wide" label="Your own passphrase" hint={`At least ${MIN_PASSPHRASE} characters, several words. The encrypted copy is public, so a short or common passphrase can be guessed offline.`} error={pass ? passphraseProblem(pass) ?? undefined : undefined}>
                          <input type="text" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" placeholder="four or more words you will remember" />
                        </Field>
                        <div className="row">
                          <button className="btn private" onClick={savePhrase} disabled={busy || !!passphraseProblem(pass)}>
                            {busy ? "Saving" : backupOnChain ? "Save new phrase" : "Save phrase"}
                          </button>
                          <button className="textbtn quiet" onClick={() => { setCustomPass(false); setPass(generatePassphrase()); setPassCopied(false); }}>Use generated words instead</button>
                          {backupOnChain ? <button className="textbtn quiet" onClick={() => { setShowPhrase(false); setPass(""); }}>Cancel</button> : null}
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="small muted" style={{ margin: "0 0 10px" }}>{backupOnChain ? "Copy the new words before you save. Saving replaces the phrase you have now, and the old one stops working." : "Copy the words before you save. An encrypted copy of the key goes on chain; only these words open it, and they are not stored anywhere."}</p>
                        <div className="secret words" aria-label="Your new recovery phrase"><code>{pass}</code></div>
                        <div className="row" style={{ margin: "12px 0 14px" }}>
                          <button className="btn secondary" onClick={copyPhrase}>{passCopied ? "Copied" : "Copy phrase"}</button>
                          <button className="textbtn quiet" onClick={() => { setPass(generatePassphrase()); setPassCopied(false); }}>New words</button>
                          <button className="textbtn quiet" onClick={() => { setCustomPass(true); setPass(""); setPassCopied(false); }}>Type my own</button>
                        </div>
                        <div className="row">
                          <button className="btn private" onClick={savePhrase} disabled={busy || !passCopied} title={!passCopied ? "Copy the phrase first" : undefined}>
                            {busy ? "Saving" : backupOnChain ? "Save new phrase" : "Save phrase"}
                          </button>
                          {backupOnChain ? <button className="textbtn quiet" onClick={() => { setShowPhrase(false); setPass(""); }}>Cancel</button> : null}
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
                <div className="method">
                  <div className="what"><b>Committee copy</b><span>The XPR Network committee can return the key after you prove you own the account. It already reads every amount, and spending still needs your wallet.</span></div>
                  <span className={`status ${recoveryOnChain ? "yes" : "no"}`}>{recoveryOnChain ? "Kept" : "Not kept"}</span>
                  {!recoveryOnChain && onStoreRecovery ? (
                    <button className="textbtn" onClick={() => run(onStoreRecovery, "Recovery copy stored with the committee.")} disabled={busy}>
                      {busy ? "Storing" : "Keep a copy"}
                    </button>
                  ) : <span />}
                </div>
                <div className="method">
                  <div className="what"><b>Key file</b><span>The raw key as a file. Keep it private: anyone with it can read your balance.</span></div>
                  <span className={`status ${fileSaved ? "yes" : "no"}`}>{fileSaved ? "Downloaded" : "Not downloaded"}</span>
                  <button className="textbtn" onClick={download}>Download</button>
                </div>
              </div>
            ) : null}

            <details>
              <summary>{keyDerived ? "Advanced: export a backup, or use a saved key" : "Advanced: key details, replace or forget this key"}</summary>
              <div className="kv">
                <span className="k">Public key</span>
                <span className="mono">{shortHex(keypair.pubkey, 12)}</span>
                <span className="k">On chain</span>
                <span>{st.registered ? `Registered for ${st.token.code}` : `Not registered for ${st.token.code} yet`}</span>
              </div>
              <div className="row" style={{ marginBottom: 16 }}>
                {keyDerived ? (
                  <button className="btn secondary" onClick={download}>
                    Export backup
                  </button>
                ) : null}
                <button className="textbtn" onClick={copy}>
                  {copied ? "Copied" : "Copy secret"}
                </button>
                {keyDerived ? (
                  <span className="small muted">Your key is re-derived from your wallet's signature, so normally there is nothing to keep. Export a backup before you change your wallet's keys: a new signing key gives a different signature, and with it a different key.</span>
                ) : null}
              </div>
              <Field label="Secret to import" hint="Replaces the key on this device. Only do this to restore a backup of the key registered for this account; anything else is refused.">
                <input className="mono" value={imp} onChange={(e) => setImp(e.target.value)} placeholder="0x" />
              </Field>
              <div className="row">
                <button className="btn secondary" onClick={() => run(() => onImportKey(imp), "Key imported.")} disabled={!imp}>
                  Import
                </button>
                <button
                  className="btn danger"
                  onClick={() => {
                    if (confirm("Forget the encryption key on this device? Without the recovery phrase, a committee copy or the key file you lose access to the confidential balance.")) onForgetKey();
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
            {msg ? (
              <div style={{ marginTop: 16 }}>
                <Note level={msg.ok ? "ok" : "error"}>{msg.text}</Note>
              </div>
            ) : null}
          </>
        )}
      </section>

      {st.registered ? (
        <section className="section divided">
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
