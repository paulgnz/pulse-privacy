import { useEffect, useMemo, useState } from "react";
import type { ConfState } from "../lib/client";
import type { CryptoBackend, EncryptionKeypair, Hex } from "../lib/crypto/types";
import { UNITS, fmtUnits, parseUnits } from "../lib/format";
import { exportBlob, saveKeypair } from "../lib/keys";
import { checkDeposit } from "../lib/privacy";
import { unlock } from "../lib/unlock";
import type { Session } from "../lib/chain";
import { Amount } from "./Amount";
import { AmountInput, EdgeNote, Field, Line, Note } from "./ui";

export type Step = "connect" | "key" | "register" | "deposit";
export type KeyMode = "unlock" | "unlock-pending" | "unlock-done" | "import" | "create" | "backup";
const STEPS: [Step, string][] = [
  ["connect", "Connect wallet"],
  ["key", "Unlock"],
  ["register", "Register"],
  ["deposit", "First deposit"],
];

export interface OnboardingProps {
  step: Step;
  /** demo-only: force a sub-state for screenshots */
  forceKeyMode?: KeyMode;
  forceSigning?: boolean;
  actor?: string;
  publicBalance: bigint | null;
  st: ConfState | null;
  keypair: EncryptionKeypair | null;
  backend: CryptoBackend;
  connectBusy: boolean;
  connectError?: string;
  onConnect: () => Promise<void>;
  /** `derived`: the secret came from the wallet signature and lives in memory only */
  onKeyReady: (kp: EncryptionKeypair, derived: boolean) => void;
  session: Session | null;
  /** returning session: derive again without the stability check, prompting at once */
  autoUnlock?: boolean;
  onRegister: () => Promise<unknown>;
  onDeposit: (amount: bigint) => Promise<unknown>;
  onFinish: () => void;
  isMock: boolean;
}

const Steps = ({ current }: { current: Step }) => {
  const idx = STEPS.findIndex(([k]) => k === current);
  return (
    <ol className="steps" aria-label="Setup steps">
      {STEPS.map(([k, label], i) => (
        <li key={k} className={i < idx ? "done" : i === idx ? "current" : ""} aria-current={i === idx ? "step" : undefined}>
          <span className="n">{i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
};

export const Onboarding = (p: OnboardingProps) => (
  <div className="wizard">
    <Steps current={p.step} />
    {p.step === "connect" ? <Connect {...p} /> : p.step === "key" ? <Key {...p} /> : p.step === "register" ? <Register {...p} /> : <FirstDeposit {...p} />}
  </div>
);

// ---------------------------------------------------------------- 1. connect

const Connect = ({ onConnect, connectBusy, connectError, actor, publicBalance }: OnboardingProps) => (
  <section className="step">
    <h1>Confidential XPR</h1>
    <div className="excerpt" aria-label="Example statement">
      <Line label="Deposit" sub="public, like any transfer">
        <Amount value={5000n * UNITS} />
      </Line>
      <Line label="Sent to bob" sub="the chain shows who and when">
        <Amount value={1234n * UNITS} hidden />
      </Line>
      <Line label="Received from carol" sub="only you, carol and the auditor can read it">
        <Amount value={250n * UNITS} hidden digits={8} />
      </Line>
    </div>
    <p className="lede">Your balance lives inside a contract as an encrypted box. Amounts stay hidden from everyone except you, the other party and the auditor. Who paid whom stays public.</p>
    {actor ? (
      <Note level="ok">
        <p>
          Connected as {actor}
          {publicBalance !== null ? `, ${fmtUnits(publicBalance)} XPR public balance` : ""}.
        </p>
      </Note>
    ) : (
      <>
        <p className="muted" style={{ marginBottom: 18 }}>Your wallet only ever signs ordinary XPR transactions. It needs no changes.</p>
        <button className="btn big" onClick={onConnect} disabled={connectBusy}>
          {connectBusy ? "Waiting for your wallet" : "Connect wallet"}
        </button>
        {connectError ? (
          <p className="small" style={{ color: "var(--error)", marginTop: 14 }}>
            {connectError}. Try again, or open your wallet first and retry.
          </p>
        ) : null}
      </>
    )}
    <p className="quiet">Testnet. Contract xprconf. Nothing here is real money.</p>
  </section>
);

// ---------------------------------------------------------------- 2. unlock (or saved key)

const Key = (p: OnboardingProps) => {
  const chainKey = p.st?.registered ? p.st.pubkey : undefined;
  const [mode, setMode] = useState<KeyMode>(p.forceKeyMode ?? "unlock");
  const [fresh, setFresh] = useState<EncryptionKeypair | null>(null);
  const [secretIn, setSecretIn] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [stage, setStage] = useState<string>("");
  const [nonDeterministic, setNonDeterministic] = useState(false);
  const [mismatch, setMismatch] = useState(false);

  useEffect(() => {
    if (p.forceKeyMode) setMode(p.forceKeyMode);
  }, [p.forceKeyMode]);

  const previewKey = useMemo<EncryptionKeypair>(
    () => fresh ?? p.keypair ?? { secret: ("0x" + "7c3d".repeat(16)) as Hex, pubkey: "0x" as Hex },
    [fresh, p.keypair]
  );

  const doUnlock = async () => {
    if (!p.session) return;
    setErr(null);
    setMode("unlock-pending");
    setStage(p.autoUnlock ? "Your wallet will ask for one signature." : "Your wallet will ask twice, to confirm the signature is stable.");
    try {
      const { secret, deterministic } = await unlock(p.session, (st) => setStage(st), !(p.autoUnlock && !!chainKey));
      if (!deterministic) {
        setNonDeterministic(true);
        setMode(chainKey ? "import" : "create");
        return;
      }
      const pubkey = await p.backend.pubkeyOf(secret);
      if (chainKey && pubkey.toLowerCase() !== chainKey.toLowerCase()) {
        setMismatch(true);
        setMode("import");
        return;
      }
      setMode("unlock-done");
      p.onKeyReady({ secret, pubkey }, true);
    } catch (e) {
      setErr((e as Error).message);
      setMode("unlock");
    }
  };

  useEffect(() => {
    if (p.autoUnlock && mode === "unlock" && !p.forceKeyMode && p.session) void doUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.autoUnlock, p.session]);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const kp = await p.backend.generateKeypair();
      setFresh(kp);
      setMode("backup");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const readFile = (f: File) =>
    new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(new Error("Could not read the file"));
      r.readAsText(f);
    });

  const importKey = async (raw: string) => {
    setBusy(true);
    setErr(null);
    try {
      let s = raw.trim();
      if (s.startsWith("{")) s = String((JSON.parse(s) as { secret?: string }).secret ?? "");
      s = s.toLowerCase();
      const secret = (s.startsWith("0x") ? s : `0x${s}`) as Hex;
      if (!/^0x[0-9a-f]{64}$/.test(secret)) throw new Error("A secret is 32 bytes of hex, or the key file you exported");
      const pubkey = await p.backend.pubkeyOf(secret);
      if (chainKey && pubkey.toLowerCase() !== chainKey.toLowerCase()) throw new Error(`This key does not match the one registered for ${p.actor}. Use the backup you made when you registered`);
      const kp = { secret, pubkey };
      if (p.actor) saveKeypair(p.actor, kp);
      p.onKeyReady(kp, false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finishBackup = () => {
    const kp = fresh ?? p.keypair;
    if (!kp || !p.actor) return;
    saveKeypair(p.actor, kp);
    p.onKeyReady(kp, false);
  };

  const download = () => {
    if (!p.actor) return;
    const blob = new Blob([exportBlob(p.actor, previewKey)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `xpr-confidential-key-${p.actor}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const copy = async () => {
    await navigator.clipboard.writeText(previewKey.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (mode === "unlock" || mode === "unlock-pending" || mode === "unlock-done") {
    const pending = mode === "unlock-pending";
    const done = mode === "unlock-done";
    return (
      <section className="step">
        <h2>Unlock</h2>
        <p className="lede">Sign once to unlock your private balance. Nothing is sent to the chain, and there is no key to back up: your wallet is the key.</p>
        {done ? (
          <Note level="ok">
            <p>Unlocked. Your wallet's signature opens your boxes on this device.</p>
          </Note>
        ) : pending ? (
          <Note level="info">
            <p>{stage || "Waiting for your wallet."}</p>
          </Note>
        ) : err ? (
          <Note level="error">
            <p>Not unlocked. {err}</p>
          </Note>
        ) : null}
        {!done && !pending ? (
          <div className="row">
            <button className="btn private" onClick={doUnlock} disabled={!p.session}>
              Sign to unlock
            </button>
            <button className="textbtn quiet" onClick={() => setMode("import")}>
              I have a saved key to import
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  if (mode === "backup") {
    return (
      <section className="step">
        <h2>Save your backup</h2>
        <p className="lede">This is the key that opens your boxes. It is shown once. Without it you cannot read your confidential balance or build the proof that spends it, and no one can recover it for you.</p>
        <div className="secret" aria-label="Your encryption secret">
          <code>{previewKey.secret}</code>
        </div>
        <div className="row" style={{ margin: "16px 0 22px" }}>
          <button className="btn secondary" onClick={download}>
            Download key file
          </button>
          <button className="textbtn" onClick={copy}>
            {copied ? "Copied" : "Copy secret"}
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>I have saved my backup somewhere safe.</span>
        </label>
        <div className="row">
          <button className="btn private" onClick={finishBackup} disabled={!saved}>
            Continue
          </button>
          <button className="textbtn quiet" onClick={() => setMode("create")}>
            Back
          </button>
        </div>
      </section>
    );
  }

  if (mode === "import") {
    return (
      <section className="step">
        <h2>Import your saved key</h2>
        <p className="lede">
          {mismatch
            ? `${p.actor} was set up with a saved key, not the one your wallet derives. Paste that secret or choose the key file you saved.`
            : nonDeterministic
              ? "This wallet's signatures change every time, so this account uses a saved key instead. Paste the secret or choose the key file you saved."
              : chainKey
                ? `${p.actor} already has an encryption key registered on chain. Paste the secret or choose the key file you saved.`
                : "Paste the secret or choose the key file you saved."}
        </p>
        <Field label="Secret or key file contents" error={err ?? undefined}>
          <input className="mono" value={secretIn} onChange={(e) => setSecretIn(e.target.value)} placeholder="0x" autoFocus />
        </Field>
        <div className="row" style={{ marginBottom: 20 }}>
          <label className="btn secondary" style={{ display: "inline-block" }}>
            Choose key file
            <input
              type="file"
              accept="application/json,.json,.txt"
              style={{ display: "none" }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) importKey(await readFile(f));
              }}
            />
          </label>
        </div>
        <div className="row">
          <button className="btn private" onClick={() => importKey(secretIn)} disabled={!secretIn || busy}>
            {busy ? "Checking" : "Continue"}
          </button>
          {!chainKey ? (
            <button className="textbtn quiet" onClick={() => setMode(nonDeterministic ? "create" : "unlock")}>
              {nonDeterministic ? "Create a new key instead" : "Back"}
            </button>
          ) : (
            <button className="textbtn quiet" onClick={() => setMode("unlock")}>
              Back
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="step">
      <h2>Create a saved key</h2>
      <p className="lede">This wallet's signatures change every time, so this account uses a saved key instead. It is created on this device and never sent anywhere.</p>
      {err ? <Note level="error">{err}</Note> : null}
      <div className="row">
        <button className="btn private" onClick={create} disabled={busy}>
          {busy ? "Creating" : "Create key"}
        </button>
        <button className="textbtn quiet" onClick={() => setMode("import")}>
          I have a saved key to import
        </button>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------- 3. register

const Register = ({ onRegister, actor, forceSigning }: OnboardingProps) => {
  const [state, setState] = useState<"idle" | "signing" | "done" | "error">(forceSigning ? "signing" : "idle");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setState("signing");
    setErr(null);
    try {
      await onRegister();
      setState("done");
    } catch (e) {
      setErr((e as Error).message);
      setState("error");
    }
  };
  return (
    <section className="step">
      <h2>Register</h2>
      <p className="lede">Publish your encryption key so others can pay you privately. One signature.</p>
      {state === "signing" ? (
        <Note level="info">
          <p>Waiting for your wallet to sign the registration for {actor}.</p>
        </Note>
      ) : state === "done" ? (
        <Note level="ok">
          <p>Registered.</p>
        </Note>
      ) : state === "error" ? (
        <Note level="error">
          <p>Not registered. {err}</p>
        </Note>
      ) : null}
      {state !== "done" ? (
        <button className="btn private" onClick={go} disabled={state === "signing"}>
          Register
        </button>
      ) : null}
    </section>
  );
};

// ---------------------------------------------------------------- 4. first deposit

const FirstDeposit = ({ st, publicBalance, onDeposit, onFinish }: OnboardingProps) => {
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const parsed = useMemo(() => {
    try {
      return amt ? parseUnits(amt) : null;
    } catch {
      return null;
    }
  }, [amt]);
  const over = parsed !== null && publicBalance !== null && parsed > publicBalance;
  const cfg = st?.config ?? { withdrawGranularity: UNITS, depositGranularity: UNITS };
  const check = parsed ? checkDeposit(parsed, cfg) : null;
  const go = async () => {
    if (!parsed) return;
    setBusy(true);
    setErr(null);
    try {
      await onDeposit(parsed);
      onFinish();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="step">
      <h2>First deposit</h2>
      <p className="lede">Move some public XPR into your box. This one transfer is visible to everyone, so a round amount reveals less than a specific one. You can skip this and deposit later.</p>
      <Field label="Amount" error={over ? `More than your public balance of ${fmtUnits(publicBalance ?? 0n)} XPR.` : err ?? undefined} hint={publicBalance !== null ? `Public balance ${fmtUnits(publicBalance)} XPR.` : undefined}>
        <AmountInput value={amt} onChange={setAmt} autoFocus />
      </Field>
      <div className="chips">
        {[100n, 500n, 1000n, 5000n].map((x) => (
          <button key={x.toString()} className="textbtn quiet" onClick={() => setAmt(x.toString())}>
            {x.toLocaleString("en-US")}
          </button>
        ))}
      </div>
      {check ? <EdgeNote check={check} onSuggest={(a) => setAmt(fmtUnits(a, { trim: true }).replace(/,/g, ""))} /> : null}
      <div className="row">
        <button className="btn" onClick={go} disabled={!parsed || parsed <= 0n || over || busy}>
          {parsed && parsed > 0n && !over ? `Deposit ${fmtUnits(parsed)} XPR` : "Deposit"}
        </button>
        <button className="textbtn quiet" onClick={onFinish}>
          Skip for now
        </button>
      </div>
    </section>
  );
};
