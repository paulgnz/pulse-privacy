import { useCallback, useEffect, useMemo, useState } from "react";
import { CONTRACT, CRYPTO_MODE, EXPLORER } from "./config";
import * as chain from "./lib/chain";
import type { Session } from "./lib/chain";
import { ConfidentialClient, type ConfState } from "./lib/client";
import { selectBackend } from "./lib/crypto";
import type { EncryptionKeypair, Hex } from "./lib/crypto/types";
import { createKeypair, forgetKeypair, importSecret, loadKeypair } from "./lib/keys";
import { Activity } from "./components/Activity";
import { Auditor } from "./components/Auditor";
import { Onboarding, type KeyMode, type Step } from "./components/Onboarding";
import { Overview } from "./components/Overview";
import { Settings } from "./components/Settings";

const TABS = [
  ["overview", "Statement"],
  ["activity", "Activity"],
  ["settings", "Settings"],
  ["auditor", "Auditor"],
] as const;
type Tab = (typeof TABS)[number][0];

const backend = selectBackend();

/**
 * Demo session: only with the simulated backend, and only when asked for
 * (`VITE_DEMO_ACTOR=alice` or `?demo=alice`). Renders every screen without a wallet.
 */
function demoActor(): string | null {
  if (CRYPTO_MODE !== "mock") return null;
  const q = new URLSearchParams(location.search).get("demo");
  const env = import.meta.env.VITE_DEMO_ACTOR as string | undefined;
  const a = (q ?? env ?? "").trim().toLowerCase();
  return /^[a-z1-5.]{1,12}$/.test(a) ? a : null;
}
/** demo-only: `?wizard=connect|key-create|key-import|key-backup|register|register-signing|deposit` previews a step */
function demoWizard(): { step: Step; keyMode?: KeyMode; signing?: boolean } | null {
  if (CRYPTO_MODE !== "mock") return null;
  const w = new URLSearchParams(location.search).get("wizard");
  if (!w) return null;
  const [step, sub] = w.split(/-(.*)/) as [string, string?];
  if (step === "connect" || step === "register" || step === "deposit") return { step, signing: sub === "signing" };
  if (step === "unlock") return { step: "key", keyMode: (sub ? `unlock-${sub}` : "unlock") as KeyMode };
  if (step === "key") return { step: "key", keyMode: (sub as KeyMode) ?? "create" };
  return null;
}
const demoSession = (actor: string): Session => ({
  auth: { actor, permission: "active" },
  transact: async () => ({}),
});
/** the simulated pool seeds each peer's key from the first letter of its name (client.ts) */
const seededSecret = (actor: string): Hex => ("0x" + actor.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)) as Hex;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [demo, setDemo] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginErr, setLoginErr] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(location.search).get("tab");
    return TABS.some(([k]) => k === t) ? (t as Tab) : "overview";
  });
  const [keypair, setKeypair] = useState<EncryptionKeypair | null>(null);
  const [keyDerived, setKeyDerived] = useState(false);
  const [restored, setRestored] = useState(false);
  const [st, setSt] = useState<ConfState | null>(null);
  const [pub, setPub] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [mockSecret, setMockSecret] = useState<Hex | null>(null);
  const [head, setHead] = useState<number | null>(null);
  const [justRegistered, setJustRegistered] = useState(false);
  const [finished, setFinished] = useState(false);
  const preview = useMemo(demoWizard, []);

  const client = useMemo(() => (session ? new ConfidentialClient(backend, session, keypair) : null), [session, keypair]);

  const refresh = useCallback(async () => {
    if (!client) return;
    const [s, p, ms] = await Promise.all([client.state(), chain.getPublicBalance(client.actor).catch(() => null), client.mockAuditorSecret()]);
    setSt(s);
    setPub(p);
    setMockSecret(ms);
  }, [client]);

  useEffect(() => {
    const d = demoActor();
    if (d) {
      setDemo(true);
      if (preview?.step === "connect") return; // preview the connect step without a session
      setSession(demoSession(d));
      if (preview?.step === "key") return; // preview the unlock/key step without a local key
      const existing = loadKeypair(d);
      if (existing) setKeypair(existing);
      else importSecret(d, backend, seededSecret(d)).then(setKeypair);
    } else {
      chain.restore().then((s) => {
        if (s) {
          setSession(s);
          setKeypair(loadKeypair(s.auth.actor));
          setRestored(true);
        }
      });
    }
    chain
      .getInfo()
      .then((i) => setHead(i.head_block_num))
      .catch(() => null);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const doLogin = async () => {
    setLoginBusy(true);
    setLoginErr(undefined);
    try {
      const s = await chain.login();
      if (!s) throw new Error("WebAuth did not return a session");
      setSession(s);
      setKeypair(loadKeypair(s.auth.actor));
    } catch (e) {
      setLoginErr((e as Error).message);
    } finally {
      setLoginBusy(false);
    }
  };

  const doLogout = async () => {
    if (!demo) await chain.logout(session);
    setSession(null);
    setSt(null);
    setKeypair(null);
    setDemo(false);
    if (demo) history.replaceState(null, "", location.pathname);
  };

  const wrap = async <T,>(f: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await f();
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const foot = (
    <div className="foot">
      {backend.isMock ? "Simulation. " : ""}
      XPR Network testnet{head ? `, block ${head.toLocaleString("en-US")}` : ""}. Contract <a href={`${EXPLORER}/account/${CONTRACT}`}>{CONTRACT}</a>. A design under development, not a product.
    </div>
  );

  // First-run wizard: resume at the first incomplete step; returning users skip it.
  const keyMatches = !!keypair && (!st?.registered || !st.pubkey || st.pubkey.toLowerCase() === keypair.pubkey.toLowerCase());
  const step: Step | null = preview
    ? preview.step
    : !session
      ? "connect"
      : session && st === null
        ? null
        : !keyMatches
          ? "key"
          : !st?.registered
            ? "register"
            : justRegistered && !finished
              ? "deposit"
              : null;

  if (step || (session && st === null)) {
    return (
      <div className="page">
        {session ? (
          <header className="topbar">
            <a className="app" href="/">
              Confidential XPR
            </a>
            <div className="account">
              <span>
                <span className={`dot ${demo || backend.isMock ? "demo" : ""}`} aria-hidden="true" />
                {backend.isMock ? "Simulation" : "Testnet"}
              </span>
              <span>
                <b>{session.auth.actor}</b>
              </span>
              <button className="textbtn quiet" onClick={doLogout}>
                Sign out
              </button>
            </div>
          </header>
        ) : null}
        {step === null ? (
          <div className="empty">Checking your account</div>
        ) : (
          <Onboarding
            step={step}
            forceKeyMode={preview?.keyMode}
            forceSigning={preview?.signing}
            actor={session?.auth.actor}
            publicBalance={pub}
            st={st}
            keypair={keypair}
            backend={backend}
            connectBusy={loginBusy}
            connectError={loginErr}
            onConnect={doLogin}
            onKeyReady={(kp, derived) => {
              setKeypair(kp);
              setKeyDerived(derived);
            }}
            session={session}
            autoUnlock={restored && !keypair && !!st?.registered}
            onRegister={async () => {
              if (!client) throw new Error("not connected");
              await wrap(() => client.register());
              setJustRegistered(true);
            }}
            onDeposit={(a) => (client ? wrap(() => client.deposit(a)) : Promise.reject(new Error("not connected")))}
            onFinish={() => setFinished(true)}
            isMock={backend.isMock}
          />
        )}
        {foot}
      </div>
    );
  }

  const actor = session!.auth.actor;

  return (
    <div className="page">
      <header className="topbar">
        <a className="app" href="/">
          Confidential XPR
        </a>
        <div className="account">
          <span>
            <span className={`dot ${demo || backend.isMock ? "demo" : ""}`} aria-hidden="true" />
            {backend.isMock ? "Simulation" : "Testnet"}
          </span>
          <span>
            <b>{actor}</b>
          </span>
          <button className="textbtn quiet" onClick={doLogout}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="nav" aria-label="Sections">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} aria-current={k === tab ? "page" : undefined}>
            {label}
            {k === "overview" && st && st.pendingCount > 0 ? ` (${st.pendingCount} pending)` : ""}
          </button>
        ))}
      </nav>

      {!st || !client ? (
        <div className="empty">Loading your statement</div>
      ) : tab === "overview" ? (
        <Overview
          st={st}
          publicBalance={pub}
          onGo={(t) => setTab(t as Tab)}
          onFold={() => wrap(() => client.applyPending())}
          onSend={(to, amount, p) => wrap(() => client.send(to, amount, p))}
          onDeposit={(a) => wrap(() => client.deposit(a))}
          onWithdraw={(a, p) => wrap(() => client.withdraw(a, p))}
          busy={busy}
        />
      ) : tab === "activity" ? (
        <Activity st={st} isMock={backend.isMock} />
      ) : tab === "settings" ? (
        <Settings
          actor={actor}
          st={st}
          keypair={keypair}
          keyDerived={keyDerived}
          backendName={backend.name}
          isMock={backend.isMock}
          onCreateKey={async () => {
            setKeypair(await createKeypair(actor, backend));
            setKeyDerived(false);
          }}
          onImportKey={async (s) => {
            setKeypair(await importSecret(actor, backend, s));
            setKeyDerived(false);
          }}
          onForgetKey={() => {
            forgetKeypair(actor);
            setKeypair(null);
            setKeyDerived(false);
          }}
          onRegister={() => wrap(() => client.register())}
          onSimulateIncoming={(from, a) => wrap(() => client.simulateIncoming(from, a))}
          onSimulatePool={(n) => wrap(() => client.simulatePoolActivity(n))}
          onResetMock={() => wrap(() => client.resetMock())}
          busy={busy}
        />
      ) : (
        <Auditor isMock={backend.isMock} onOpen={(s) => client.auditorLedger(s)} onEdges={() => client.poolEdges()} mockSecret={mockSecret} />
      )}

      {foot}
    </div>
  );
}
