import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONTRACT, CRYPTO_MODE, EXPLORER, NETWORK_LABEL, OTHER_NETWORK } from "./config";
import { fmtUnits } from "./lib/format";
import * as chain from "./lib/chain";
import type { Session } from "./lib/chain";
import { ConfidentialClient, MOCK_TOKENS, type ActivityItem, type ConfState } from "./lib/client";
import { XPR, rememberToken, rememberedToken, type Token } from "./lib/token";
import { selectBackend } from "./lib/crypto";
import type { EncryptionKeypair, Hex } from "./lib/crypto/types";
import { createKeypair, forgetKeypair, importSecret, loadKeypair } from "./lib/keys";
import { About } from "./components/About";
import { Note } from "./components/ui";
import { Activity } from "./components/Activity";
import { Auditor } from "./components/Auditor";
import { Brand } from "./components/Brand";
import { Onboarding, type KeyMode, type Step } from "./components/Onboarding";
import { Overview } from "./components/Overview";
import { Settings } from "./components/Settings";

const TABS = [
  ["overview", "Statement"],
  ["activity", "Activity"],
  ["auditor", "Auditor"],
  ["settings", "Settings"],
] as const;
type Tab = (typeof TABS)[number][0];

const backend = selectBackend();

/** path-based routes: "/" is the app, "/about" is How it works */
type Route = "app" | "about";
const routeOf = (path: string): Route => (path.replace(/\/+$/, "") === "/about" ? "about" : "app");

/**
 * Simulated session: only with the simulated backend, and only when asked for
 * (`VITE_DEMO_ACTOR=alice` or `?demo=alice`). Renders every screen without a wallet.
 */
function demoActor(): string | null {
  if (CRYPTO_MODE !== "mock") return null;
  const q = new URLSearchParams(location.search).get("demo");
  const env = import.meta.env.VITE_DEMO_ACTOR as string | undefined;
  const a = (q ?? env ?? "").trim().toLowerCase();
  return /^[a-z1-5.]{1,12}$/.test(a) ? a : null;
}
/** simulation-only: `?wizard=connect|key-create|key-import|key-backup|register|register-signing|deposit` previews a step */
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
  const [route, setRoute] = useState<Route>(() => routeOf(location.pathname));
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
  const [justRegistered, setJustRegistered] = useState(false);
  const [finished, setFinished] = useState(false);
  const preview = useMemo(demoWizard, []);

  // Tokens come from the contract's config table (XPR first); the simulation lists XPR and XMD.
  const [tokens, setTokens] = useState<Token[]>(backend.isMock ? MOCK_TOKENS : [XPR]);
  const [tokenCode, setTokenCode] = useState<string>(() => {
    // shareable link: ?token=XMD opens the site on that token
    try {
      const q = new URLSearchParams(location.search).get("token");
      if (q) { rememberToken(q.toUpperCase()); return q.toUpperCase(); }
    } catch { /* ignore */ }
    return rememberedToken() ?? "XPR";
  });
  const token = useMemo(() => tokens.find((t) => t.code === tokenCode) ?? tokens[0], [tokens, tokenCode]);
  useEffect(() => {
    if (backend.isMock) return;
    chain.listTokens().then((ts) => { if (ts.length) setTokens(ts); }).catch(() => { /* keep XPR */ });
  }, []);
  const chooseToken = (code: string) => {
    rememberToken(code);
    setTokenCode(code);
  };
  // Which tokens this account has registered for, so a second token gets a one-line register
  // action on the statement rather than the first-run wizard.
  const [registeredFor, setRegisteredFor] = useState<Record<string, boolean>>({});
  const probedFirst = useRef(false);

  const navigate = useCallback((path: string) => {
    history.pushState(null, "", path + (path === "/" ? location.search : ""));
    setRoute(routeOf(path));
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const onPop = () => setRoute(routeOf(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const client = useMemo(() => (session ? new ConfidentialClient(backend, session, keypair, token) : null), [session, keypair, token]);

  const [refreshing, setRefreshing] = useState(false);
  // Two phases: balances first (fast, what the statement needs), then the ledger. A slow or
  // down indexer must never hold the statement hostage.
  const refresh = useCallback(async (opts: { history?: boolean } = { history: true }) => {
    if (!client) return;
    setRefreshing(true);
    try {
      const [quick, p, ms] = await Promise.all([client.state({ history: false }), chain.getPublicBalance(client.actor, client.token).catch(() => null), client.mockAuditorSecret()]);
      setSt((prev) => (prev?.historyLoaded && prev.token.code === quick.token.code ? { ...quick, activity: prev.activity, incoming: prev.incoming, edgesSinceLastIncoming: prev.edgesSinceLastIncoming, historyLoaded: true } : quick));
      setPub(p);
      setMockSecret(ms);
      setRegisteredFor((r) => (r[quick.token.code] === quick.registered ? r : { ...r, [quick.token.code]: quick.registered }));
      // a returning user who last used a second token: check the first one once, so an XPR
      // account that has not registered for XMD is not sent back through the wizard
      if (!quick.registered && client.token.code !== tokens[0].code && !probedFirst.current) {
        probedFirst.current = true;
        try {
          const first = await new ConfidentialClient(backend, client.session, client.keypair, tokens[0]).state({ history: false });
          setRegisteredFor((r) => ({ ...r, [tokens[0].code]: first.registered }));
        } catch { /* ignore */ }
      }
      if (opts.history !== false) {
        const full = await client.state({ history: true });
        setSt(full);
      }
    } finally {
      setRefreshing(false);
    }
  }, [client, tokens]);

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
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh({ history: false }); }, 15000);
    const h = setInterval(() => { if (document.visibilityState === "visible") refresh({ history: true }); }, tab === "activity" ? 20000 : 60000);
    return () => { clearInterval(t); clearInterval(h); };
  }, [refresh, tab]);

  // Notify on incoming confidential transfers: compare pending between refreshes.
  const [received, setReceived] = useState<string | null>(null);
  const prevPending = useRef<{ count: number; amount: bigint; token: string } | null>(null);
  useEffect(() => {
    if (!st) return;
    const cur = { count: st.pendingCount, amount: st.pending, token: st.token.code };
    const prev = prevPending.current;
    prevPending.current = cur;
    if (!prev || prev.token !== cur.token || cur.count <= prev.count) return;
    const delta = cur.amount - prev.amount;
    const msg = delta > 0n ? `You received ${fmtUnits(delta, st.token)} ${st.token.code} inside the contract. It is in your pending box.` : `You received a confidential ${st.token.code} transfer. It is in your pending box.`;
    setReceived(msg);
    document.title = `(${cur.count}) Confidential XPR`;
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Confidential XPR", { body: msg });
    } catch { /* ignore */ }
  }, [st]);
  useEffect(() => { if (!received) document.title = "Confidential XPR"; }, [received]);
  const askNotify = async () => { try { await Notification.requestPermission(); } catch { /* ignore */ } };

  const doLogin = async () => {
    setLoginBusy(true);
    setLoginErr(undefined);
    try {
      const s = await chain.login();
      if (!s) throw new Error("WebAuth did not return a session");
      setSession(s);
      setKeypair(loadKeypair(s.auth.actor));
      if (route === "about") navigate("/");
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

  // Optimistic ledger rows for actions we just sent, until the indexer has them.
  const [optimistic, setOptimistic] = useState<ActivityItem[]>([]);
  const pollTimers = useRef<number[]>([]);
  const trackTx = (txid: string, item: Omit<ActivityItem, "id" | "ts" | "onChain"> & { onChain?: Partial<ActivityItem["onChain"]> }) => {
    if (!txid) return;
    setOptimistic((o) => [{ id: `opt/${txid}`, ts: Date.now(), ...item, onChain: { public: false, ...(item.onChain ?? {}), txid }, confirming: true }, ...o]);
    // poll the ledger until the indexer has the transaction (2, 5, 10, 20, 40 s)
    for (const d of [2000, 5000, 10000, 20000, 40000]) pollTimers.current.push(window.setTimeout(() => refresh({ history: true }), d));
  };
  useEffect(() => {
    if (!st?.activity) return;
    const seen = new Set(st.activity.map((a) => a.onChain.txid).filter(Boolean));
    setOptimistic((o) => o.filter((x) => !seen.has(x.onChain.txid)));
  }, [st]);

  const wrap = async <T,>(f: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await f();
    } finally {
      setBusy(false);
      await refresh({ history: false });
    }
  };

  // First-run wizard: resume at the first incomplete step; returning users skip it.
  const keyMatches = !!keypair && (!st?.registered || !st.pubkey || st.pubkey.toLowerCase() === keypair.pubkey.toLowerCase());
  const registeredSomewhere = !!st?.registered || Object.values(registeredFor).some(Boolean);
  const step: Step | null = preview
    ? preview.step
    : !session
      ? "connect"
      : session && st === null
        ? null
        : !keyMatches
          ? "key"
          : !st?.registered && !registeredSomewhere
            ? "register"
            : justRegistered && !finished
              ? "deposit"
              : null;
  const inApp = !!session && step === null && st !== null;

  const link = (path: string, label: string, current: boolean) => (
    <a
      href={path}
      aria-current={current ? "page" : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(path);
      }}
    >
      {label}
    </a>
  );

  const header = (
    <header className="topbar">
      <Brand onNavigate={navigate} />
      <div className="right">
        {session ? (
          <>
            {inApp && route === "about" ? link("/", "Statement", false) : null}
            {link("/about", "How it works", route === "about")}
            <a className="textbtn quiet" href={OTHER_NETWORK.url} title={`Switch to the ${OTHER_NETWORK.label.toLowerCase()} site`}>
              Switch to {OTHER_NETWORK.label.toLowerCase()}
            </a>
            <span className="who">
              <span className={`dot ${demo || backend.isMock ? "demo" : ""}`} aria-hidden="true" />
              <b>{session.auth.actor}</b>
              <button className="textbtn quiet" onClick={doLogout}>
                Sign out
              </button>
            </span>
          </>
        ) : (
          <>
            {link("/about", "How it works", route === "about")}
            <a className="textbtn quiet" href={OTHER_NETWORK.url} title={`Switch to the ${OTHER_NETWORK.label.toLowerCase()} site`}>
              Switch to {OTHER_NETWORK.label.toLowerCase()}
            </a>
            <button className="textbtn" onClick={doLogin} disabled={loginBusy}>
              Connect wallet
            </button>
          </>
        )}
      </div>
    </header>
  );

  const foot = (
    <div className="foot">
      {backend.isMock ? "Simulation. " : ""}
      Running on {NETWORK_LABEL}. Contract <a href={`${EXPLORER}/account/${CONTRACT}`}>{CONTRACT}</a>.
    </div>
  );

  if (route === "about") {
    return (
      <div className="page">
        {header}
        <About signedIn={!!session} onConnect={session ? undefined : doLogin} />
        {foot}
      </div>
    );
  }

  if (step || (session && st === null)) {
    return (
      <div className="page">
        {header}
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
            onAbout={() => navigate("/about")}
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
            token={token}
          />
        )}
        {foot}
      </div>
    );
  }

  const actor = session!.auth.actor;

  return (
    <div className="page">
      {header}

      <nav className="nav" aria-label="Sections">
        {TABS.map(([k, label]) => (
          <a
            key={k}
            href={`?tab=${k}`}
            onClick={(e) => {
              e.preventDefault();
              setTab(k);
            }}
            aria-current={k === tab ? "page" : undefined}
          >
            {label}
            {k === "overview" && st && st.pendingCount > 0 ? ` (${st.pendingCount} pending)` : ""}
          </a>
        ))}
        {tokens.length > 1 ? (
          <span className="tokens" role="group" aria-label="Token">
            {tokens.map((t) => (
              <button key={t.code} onClick={() => chooseToken(t.code)} aria-pressed={t.code === token.code} title={`Confidential ${t.code}`}>
                {t.code}
              </button>
            ))}
          </span>
        ) : null}
      </nav>

      {received ? (
        <Note level="ok">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
            <span>{received}</span>
            <span className="row" style={{ gap: 14 }}>
              {typeof Notification !== "undefined" && Notification.permission === "default" ? (
                <button className="textbtn quiet" onClick={askNotify}>Notify me on this device</button>
              ) : null}
              <button className="textbtn quiet" onClick={() => setReceived(null)}>Dismiss</button>
            </span>
          </div>
        </Note>
      ) : null}
      {!st || !client || st.token.code !== token.code ? (
        <div className="empty">Loading your statement</div>
      ) : tab === "overview" ? (
        <Overview
          st={st}
          hasKey={!!keypair}
          onRegister={() => wrap(() => client.register())}
          publicBalance={pub}
          onGo={(t) => setTab(t as Tab)}
          onFold={() => wrap(async () => { const tx = await client.applyPending(); trackTx(String(tx), { kind: "fold", onChain: { ciphertext: "●●●●" } }); return tx; })}
          onSend={(to, amount, p) => wrap(async () => { const tx = await client.send(to, amount, p); trackTx(tx, { kind: "send", amount, counterparty: to }); return tx; })}
          onDeposit={(a) => wrap(async () => { const tx = await client.deposit(a); trackTx(tx, { kind: "deposit", amount: a, onChain: { public: true } }); return tx; })}
          onWithdraw={(a, p) => wrap(async () => { const tx = await client.withdraw(a, p); trackTx(tx, { kind: "withdraw", amount: a, onChain: { public: true } }); return tx; })}
          busy={busy} refreshing={refreshing}
          tokens={tokens} onSelectToken={chooseToken}
        />
      ) : tab === "activity" ? (
        <Activity st={optimistic.length ? { ...st, activity: [...optimistic, ...st.activity] } : st} isMock={backend.isMock} />
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
        <Auditor isMock={backend.isMock} onOpen={(s) => client.auditorLedger(s)} onEdges={() => client.poolEdges()} mockSecret={mockSecret} token={token} />
      )}

      {foot}
    </div>
  );
}
