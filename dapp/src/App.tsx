import { useCallback, useEffect, useMemo, useState } from "react";
import { CONTRACT, EXPLORER } from "./config";
import * as chain from "./lib/chain";
import type { Session } from "./lib/chain";
import { ConfidentialClient, type ConfState } from "./lib/client";
import { selectBackend } from "./lib/crypto";
import type { EncryptionKeypair, Hex } from "./lib/crypto/types";
import { createKeypair, forgetKeypair, importSecret, loadKeypair } from "./lib/keys";
import { Activity } from "./components/Activity";
import { Auditor } from "./components/Auditor";
import { Deposit } from "./components/Deposit";
import { Login } from "./components/Login";
import { Overview } from "./components/Overview";
import { Send } from "./components/Send";
import { Settings } from "./components/Settings";
import { Withdraw } from "./components/Withdraw";
import { Padlock } from "./components/ui";

const TABS = ["overview", "send", "deposit", "withdraw", "activity", "settings", "auditor"] as const;
type Tab = (typeof TABS)[number];

const backend = selectBackend();

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginErr, setLoginErr] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>("overview");
  const [keypair, setKeypair] = useState<EncryptionKeypair | null>(null);
  const [st, setSt] = useState<ConfState | null>(null);
  const [pub, setPub] = useState<bigint | null>(null);
  const [escrow, setEscrow] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [mockSecret, setMockSecret] = useState<Hex | null>(null);
  const [head, setHead] = useState<number | null>(null);

  const client = useMemo(() => (session ? new ConfidentialClient(backend, session, keypair) : null), [session, keypair]);

  const refresh = useCallback(async () => {
    if (!client) return;
    const [s, p, e, ms] = await Promise.all([
      client.state(),
      chain.getPublicBalance(client.actor).catch(() => null),
      client.escrow().catch(() => null),
      client.mockAuditorSecret(),
    ]);
    setSt(s);
    setPub(p);
    setEscrow(e);
    setMockSecret(ms);
  }, [client]);

  useEffect(() => {
    chain.restore().then((s) => {
      if (s) {
        setSession(s);
        setKeypair(loadKeypair(s.auth.actor));
      }
    });
    chain.getInfo().then((i) => setHead(i.head_block_num)).catch(() => null);
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
      if (!s) throw new Error("no session returned");
      setSession(s);
      setKeypair(loadKeypair(s.auth.actor));
    } catch (e) {
      setLoginErr((e as Error).message);
    } finally {
      setLoginBusy(false);
    }
  };

  const doLogout = async () => {
    await chain.logout(session);
    setSession(null);
    setSt(null);
    setKeypair(null);
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

  if (!session) {
    return (
      <>
        {backend.isMock ? (
          <div className="banner">
            <b>MOCK MODE</b> · crypto and contract are simulated in your browser · only the WebAuth login and the public XPR balance are real
          </div>
        ) : null}
        <div className="shell">
          <Login onLogin={doLogin} busy={loginBusy} error={loginErr} />
          <div className="foot">
            XPR NETWORK TESTNET {head ? `· HEAD ${head.toLocaleString("en-US")}` : ""} · <a href={`${EXPLORER}/account/${CONTRACT}`}>{CONTRACT}</a>
          </div>
        </div>
      </>
    );
  }

  const actor = session.auth.actor;

  return (
    <>
      {backend.isMock ? (
        <div className="banner">
          <b>MOCK MODE</b> · crypto and contract are simulated in your browser · only the WebAuth login and the public XPR balance are real
        </div>
      ) : null}
      <div className="shell">
        <div className="topbar">
          <div className="brand">
            <span className="glyph">
              <Padlock size={18} color="#0b101f" />
            </span>
            Confidential XPR
            <span className="sub">TESTNET</span>
          </div>
          <div className="who">
            <span>
              <span className="name">{actor}</span>@{session.auth.permission}
            </span>
            <button className="btn ghost sm" onClick={doLogout}>
              Disconnect
            </button>
          </div>
        </div>

        <nav className="nav">
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {t}
              {t === "overview" && st && st.pendingCount > 0 ? ` · ${st.pendingCount}` : ""}
            </button>
          ))}
          <span className="spacer" />
        </nav>

        {!st || !client ? (
          <div className="empty">Loading…</div>
        ) : tab === "overview" ? (
          <Overview st={st} publicBalance={pub} escrow={escrow} onGo={(t) => setTab(t as Tab)} onFold={() => wrap(() => client.applyPending())} busy={busy} />
        ) : tab === "send" ? (
          <Send st={st} onSend={(to, amount, p) => wrap(() => client.send(to, amount, p))} busy={busy} />
        ) : tab === "deposit" ? (
          <Deposit st={st} publicBalance={pub} onDeposit={(a) => wrap(() => client.deposit(a))} busy={busy} />
        ) : tab === "withdraw" ? (
          <Withdraw st={st} onWithdraw={(a, p) => wrap(() => client.withdraw(a, p))} busy={busy} />
        ) : tab === "activity" ? (
          <Activity st={st} isMock={backend.isMock} />
        ) : tab === "settings" ? (
          <Settings
            actor={actor}
            st={st}
            keypair={keypair}
            backendName={backend.name}
            isMock={backend.isMock}
            onCreateKey={async () => setKeypair(await createKeypair(actor, backend))}
            onImportKey={async (s) => setKeypair(await importSecret(actor, backend, s))}
            onForgetKey={() => {
              forgetKeypair(actor);
              setKeypair(null);
            }}
            onRegister={() => wrap(() => client.register())}
            onSimulateIncoming={(from, a) => wrap(() => client.simulateIncoming(from, a))}
            onSimulatePool={(n) => wrap(() => client.simulatePoolActivity(n))}
            onResetMock={() => wrap(() => client.resetMock())}
            busy={busy}
          />
        ) : (
          <Auditor isMock={backend.isMock} onOpen={(s) => client.auditorLedger(s)} mockSecret={mockSecret} />
        )}

        <div className="foot">
          XPR NETWORK TESTNET {head ? `· HEAD ${head.toLocaleString("en-US")}` : ""} · CONTRACT <a href={`${EXPLORER}/account/${CONTRACT}`}>{CONTRACT}</a> · A DESIGN UNDER DEVELOPMENT, NOT A PRODUCT
        </div>
      </div>
    </>
  );
}
