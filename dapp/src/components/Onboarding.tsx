import { useEffect, useMemo, useState } from "react";
import type { ConfState } from "../lib/client";
import type { CryptoBackend, EncryptionKeypair, Hex } from "../lib/crypto/types";
import { amountProblem, fmtUnits, parseUnits } from "../lib/format";
import { XPR, type Token } from "../lib/token";
import { exportBlob, saveKeypair } from "../lib/keys";
import { checkDeposit } from "../lib/privacy";
import { unlockOnce } from "../lib/unlock";
import type { Session } from "../lib/chain";
import { AmountInput, Busy, EdgeNote, Field, Note } from "./ui";
import { NETWORK } from "../config";

export type Step = "connect" | "key" | "register" | "deposit";
export type KeyMode = "unlock" | "unlock-pending" | "confirm" | "confirm-pending" | "legacy" | "legacy-pending" | "unlock-done" | "import" | "create" | "backup";
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
  /** the token the Register / First deposit steps act on */
  token?: Token;
  /** open the How it works page */
  onAbout?: () => void;
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
    {p.step !== "connect" ? <Steps current={p.step} /> : null}
    {p.step === "connect" ? <Connect {...p} /> : p.step === "key" ? <Key {...p} /> : p.step === "register" ? <Register {...p} /> : <FirstDeposit {...p} />}
  </div>
);

// ---------------------------------------------------------------- 1. connect (the landing)

const Connect = ({ onConnect, connectBusy, connectError, actor, publicBalance, onAbout, isMock, token = XPR }: OnboardingProps) => (
  <section className="step landing">
    <h1>Private balances on XPR Network</h1>
    <p className="lede">Hold and send XPR with the amount hidden from everyone except you, the other party and the designated auditor.</p>
    {actor ? (
      <Note level="ok">
        <p>
          Connected as {actor}
          {publicBalance !== null ? `, ${fmtUnits(publicBalance, token)} ${token.code} public balance` : ""}.
        </p>
      </Note>
    ) : (
      <>
        <div className="row">
          <button className="btn big" onClick={onConnect} disabled={connectBusy}>
            {connectBusy ? <Busy>Waiting for your wallet</Busy> : "Connect wallet"}
          </button>
          {onAbout ? (
            <a
              href="/about"
              onClick={(e) => {
                e.preventDefault();
                onAbout();
              }}
            >
              How it works
            </a>
          ) : null}
        </div>
        {connectError ? (
          <p className="small" style={{ color: "var(--error)", marginTop: 14 }}>
            {connectError}. Try again, or open your wallet first and retry.
          </p>
        ) : null}
      </>
    )}
    <p className="quiet">{isMock ? "Simulation. " : ""}{NETWORK === "mainnet" ? "Mainnet, early access: the pool is capped while the trusted-setup ceremony and audit complete." : "Testnet. Nothing here is real money."}</p>
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

  // One wallet popup per click: the first click signs and derives; for a first-time account a
  // second click signs again and the two signatures must match (deterministic wallet). Returning
  // accounts are checked against the pubkey registered on chain instead.
  const [firstSig, setFirstSig] = useState<{ signature: string; secret: Hex } | null>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (mode !== "unlock-pending" && mode !== "confirm-pending") { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, [mode]);

  const finish = async (secret: Hex, fromLegacy = false) => {
    const pubkey = await p.backend.pubkeyOf(secret);
    if (chainKey && pubkey.toLowerCase() !== chainKey.toLowerCase()) {
      if (!fromLegacy) { setMode("legacy"); return; } // registered before the message changed?
      setMismatch(true);
      setMode("import");
      return;
    }
    setMode("unlock-done");
    p.onKeyReady({ secret, pubkey }, true);
  };

  const doUnlock = async () => {
    if (!p.session) return;
    setErr(null);
    setMode("unlock-pending");
    setStage("Waiting for your wallet.");
    try {
      const r = await unlockOnce(p.session);
      if (chainKey) {
        await finish(r.secret); // registered account: the chain tells us whether the key is right
      } else {
        setFirstSig(r);
        setMode("confirm");
      }
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setMode("unlock");
    }
  };

  const doLegacy = async () => {
    if (!p.session) return;
    setErr(null);
    setMode("legacy-pending");
    setStage("Waiting for your wallet.");
    try {
      const r = await unlockOnce(p.session, true);
      await finish(r.secret, true);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setMode("legacy");
    }
  };

  const doConfirm = async () => {
    if (!p.session || !firstSig) return;
    setErr(null);
    setMode("confirm-pending");
    setStage("Waiting for your wallet.");
    try {
      const r = await unlockOnce(p.session);
      if (r.signature !== firstSig.signature) {
        setNonDeterministic(true);
        setMode("create");
        return;
      }
      await finish(r.secret);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setMode("confirm");
    }
  };

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

  if (mode === "unlock" || mode === "unlock-pending" || mode === "confirm" || mode === "confirm-pending" || mode === "legacy" || mode === "legacy-pending" || mode === "unlock-done") {
    const pending = mode === "unlock-pending" || mode === "confirm-pending" || mode === "legacy-pending";
    const confirm = mode === "confirm" || mode === "confirm-pending";
    const legacy = mode === "legacy" || mode === "legacy-pending";
    const done = mode === "unlock-done";
    return (
      <section className="step">
        <h2>{confirm ? "Confirm your key" : legacy ? "Unlock with the previous message" : "Unlock"}</h2>
        <p className="lede">
          {legacy
            ? "This account was registered before the unlock message changed, so its key comes from the earlier message. Sign it once to unlock. To move to the new message later, withdraw and register again."
            : confirm
            ? "Sign once more. The two signatures must match, which proves your wallet always derives the same key. This check happens only the first time."
            : chainKey
              ? "Sign once to unlock your private balance. Nothing is sent to the chain."
              : "Sign once to unlock your private balance. Nothing is sent to the chain, and there is no key to back up: your wallet is the key."}
        </p>
        {done ? (
          <Note level="ok">
            <p>Unlocked. Your wallet's signature opens your boxes on this device.</p>
          </Note>
        ) : pending ? (
          <Note level="info">
            <p><Busy>{stage || "Waiting for your wallet."}</Busy></p>
            {slow ? (
              <p>
                Still waiting? On a phone, approve the request in the WebAuth app and come back to this tab. On a computer, your browser may be blocking pop-ups from this site: allow them for {location.host}, then{" "}
                <button className="textbtn" onClick={() => setMode(confirm ? "confirm" : legacy ? "legacy" : "unlock")}>try again</button>.
              </p>
            ) : null}
          </Note>
        ) : err ? (
          <Note level="error">
            <p>Not signed. {err}</p>
          </Note>
        ) : null}
        {!done && !pending ? (
          <div className="row">
            <button className="btn private" onClick={confirm ? doConfirm : legacy ? doLegacy : doUnlock} disabled={!p.session}>
              {confirm ? "Sign again to confirm" : legacy ? "Sign the previous message" : "Sign to unlock"}
            </button>
            {!confirm && !legacy ? (
              <button className="textbtn quiet" onClick={() => setMode("import")}>
                I have a saved key to import
              </button>
            ) : null}
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

const Register = ({ onRegister, actor, forceSigning, token = XPR }: OnboardingProps) => {
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
      <p className="lede">Publish your encryption key for {token.code} so others can pay you privately. One signature.</p>
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

const FirstDeposit = ({ st, publicBalance, onDeposit, onFinish, token = XPR }: OnboardingProps) => {
  const T = st?.token ?? token;
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const parsed = useMemo(() => {
    try {
      return amt ? parseUnits(amt, T) : null;
    } catch {
      return null;
    }
  }, [amt, T]);
  const over = parsed !== null && publicBalance !== null && parsed > publicBalance;
  const cfg = st?.config ?? { withdrawGranularity: T.units, depositGranularity: T.units, units: T.units };
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
      <p className="lede">Move some public {T.code} into your box. This one transfer is visible to everyone, so a round amount reveals less than a specific one. You can skip this and deposit later.</p>
      <Field label="Amount" error={over ? `More than your public balance of ${fmtUnits(publicBalance ?? 0n, T)} ${T.code}.` : err ?? amountProblem(amt, T) ?? undefined} hint={publicBalance !== null ? `Public balance ${fmtUnits(publicBalance, T)} ${T.code}.` : undefined}>
        <AmountInput value={amt} onChange={setAmt} autoFocus token={T} />
      </Field>
      <div className="chips">
        {[100n, 500n, 1000n, 5000n].map((x) => (
          <button key={x.toString()} className="textbtn quiet" onClick={() => setAmt(x.toString())}>
            {x.toLocaleString("en-US")}
          </button>
        ))}
      </div>
      {check ? <EdgeNote check={check} token={T} onSuggest={(a) => setAmt(fmtUnits(a, T, { trim: true }).replace(/,/g, ""))} /> : null}
      <div className="row">
        <button className="btn" onClick={go} disabled={!parsed || parsed <= 0n || over || busy}>
          {parsed && parsed > 0n && !over ? `Deposit ${fmtUnits(parsed, T)} ${T.code}` : "Deposit"}
        </button>
        <button className="textbtn quiet" onClick={onFinish}>
          Skip for now
        </button>
      </div>
    </section>
  );
};
