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
        <h2>Encryption key</h2>
        {keyDerived ? (
          <p className="lede">Your key is derived from your wallet. Each time you sign in, one signature unlocks your boxes on this device; nothing is stored here. It stays the same as long as your wallet's signing key does.</p>
        ) : (
          <>
            <p className="lede">Your wallet signs with a passkey, so this app keeps a saved key for you. The key reads your confidential balance and builds the proofs that spend it. It is separate from your wallet's signing key and lives only in this browser, so you need a way to get it back if this device is lost.</p>
            <div className="backups" aria-label="Ways to get this key back">
              <span className="k">Recovery phrase</span>
              <span className={backupOnChain ? "yes" : "no"}>{backupOnChain ? "Set" : "Not set"}</span>
              <span className="why">Seven words that restore the key on any device.</span>
              <span className="k">Committee copy</span>
              <span className={recoveryOnChain ? "yes" : "no"}>{recoveryOnChain ? "Kept" : "Not kept"}</span>
              <span className="why">The XPR Network committee can return the key after you prove you own the account.</span>
              <span className="k">Key file</span>
              <span className={fileSaved ? "yes" : "no"}>{fileSaved ? "Saved" : "Not saved"}</span>
              <span className="why">The raw key as a file, for people who prefer one.</span>
            </div>
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

            {!keyDerived && onStoreBackup ? (
              <>
                <h3>Recovery phrase</h3>
                <p>
                  {backupOnChain
                    ? "A copy of the key, locked with your phrase, is on chain. On a new device, sign in and type the phrase to get the key back. Nobody can reset the phrase, and it is not stored anywhere."
                    : "Sets a phrase that restores this key on any device. An encrypted copy of the key goes on chain; only the phrase opens it. The phrase itself is never stored anywhere, so copy it first."}
                </p>
                {!showPhrase ? (
                  <div className="row">
                    <button className="btn secondary" onClick={() => { setPass(generatePassphrase()); setCustomPass(false); setPassCopied(false); setShowPhrase(true); }}>
                      Change the phrase
                    </button>
                  </div>
                ) : customPass ? (
                  <>
                    <Field className="wide" label="Your own passphrase" hint={`At least ${MIN_PASSPHRASE} characters, several words. The encrypted copy is public, so a short or common passphrase can be guessed offline.`} error={pass ? passphraseProblem(pass) ?? undefined : undefined}>
                      <input type="text" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" placeholder="four or more words you will remember" />
                    </Field>
                    <div className="row" style={{ marginBottom: 8 }}>
                      <button className="btn private" onClick={savePhrase} disabled={busy || !!passphraseProblem(pass)}>
                        {busy ? "Saving" : backupOnChain ? "Save new phrase" : "Save phrase"}
                      </button>
                      <button className="textbtn quiet" onClick={() => { setCustomPass(false); setPass(generatePassphrase()); setPassCopied(false); }}>Use generated words instead</button>
                      {backupOnChain ? <button className="textbtn quiet" onClick={() => { setShowPhrase(false); setPass(""); }}>Cancel</button> : null}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="secret words" aria-label="Your new recovery phrase"><code>{pass}</code></div>
                    <div className="row" style={{ margin: "12px 0 14px" }}>
                      <button className="btn secondary" onClick={copyPhrase}>{passCopied ? "Copied" : "Copy phrase"}</button>
                      <button className="textbtn quiet" onClick={() => { setPass(generatePassphrase()); setPassCopied(false); }}>New words</button>
                      <button className="textbtn quiet" onClick={() => { setCustomPass(true); setPass(""); setPassCopied(false); }}>Type my own</button>
                    </div>
                    <div className="row" style={{ marginBottom: 8 }}>
                      <button className="btn private" onClick={savePhrase} disabled={busy || !passCopied} title={!passCopied ? "Copy the phrase first" : undefined}>
                        {busy ? "Saving" : backupOnChain ? "Save new phrase" : "Save phrase"}
                      </button>
                      {backupOnChain ? <button className="textbtn quiet" onClick={() => { setShowPhrase(false); setPass(""); }}>Cancel</button> : null}
                    </div>
                    <p className="small muted">{backupOnChain ? "Saving replaces the phrase you have now; the old one stops working. Copy the new words before you save." : "Copy the words before you save. They cannot be shown again."}</p>
                  </>
                )}
              </>
            ) : null}

            {!keyDerived ? (
              <>
                <h3>Committee copy</h3>
                {recoveryOnChain ? (
                  <p>An encrypted copy of this key is stored on chain with your registration. Only the committee's viewing key opens it. If you lose the key and the phrase, the committee returns it after you prove you own the account. The committee can already read every amount, so this gives it nothing new, and spending still needs your wallet.</p>
                ) : (
                  <>
                    <p>Stores an encrypted copy of this key on chain that only the committee's viewing key opens. If you lose the key and the phrase, the committee returns it after you prove you own the account. The committee can already read every amount, so this gives it nothing new, and spending still needs your wallet.</p>
                    {onStoreRecovery ? (
                      <div className="row">
                        <button className="btn secondary" onClick={() => run(onStoreRecovery, "Recovery copy stored with the committee.")} disabled={busy}>
                          {busy ? "Storing" : "Keep a copy with the committee"}
                        </button>
                      </div>
                    ) : null}
                  </>
                )}

                <h3>Key file</h3>
                <p>The raw key, for people who prefer a file. The recovery phrase restores the same key, so this is optional. Keep the file somewhere private: anyone with it can read your balance.</p>
                <div className="row" style={{ marginBottom: 20 }}>
                  <button className="btn secondary" onClick={download}>
                    Download key file
                  </button>
                  <button className="textbtn" onClick={copy}>
                    {copied ? "Copied" : "Copy secret"}
                  </button>
                </div>
              </>
            ) : null}

            <details>
              <summary>{keyDerived ? "Advanced: export a backup, or use a saved key" : "Advanced: replace or forget this key"}</summary>
              {keyDerived ? (
                <div className="row" style={{ marginBottom: 16 }}>
                  <button className="btn secondary" onClick={download}>
                    Export backup
                  </button>
                  <button className="textbtn" onClick={copy}>
                    {copied ? "Copied" : "Copy secret"}
                  </button>
                  <span className="small muted">Your key is re-derived from your wallet's signature, so normally there is nothing to keep. Export a backup before you change your wallet's keys: a new signing key gives a different signature, and with it a different key.</span>
                </div>
              ) : null}
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
