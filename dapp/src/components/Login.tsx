import { Padlock, Tag } from "./ui";

export const Login = ({ onLogin, busy, error }: { onLogin: () => void; busy: boolean; error?: string }) => (
  <div className="login">
    <div>
      <Padlock size={56} />
      <h1>Confidential XPR</h1>
      <div className="line">Hidden amounts. Visible parties. One auditor key. Your balance lives inside the contract, as a box only you and the auditor can open.</div>
      <div className="trio">
        <Tag kind="hidden">HIDDEN AMOUNTS</Tag>
        <Tag kind="public">VISIBLE PARTIES</Tag>
        <Tag kind="audit">ONE AUDITOR KEY</Tag>
      </div>
      <button className="btn primary" onClick={onLogin} disabled={busy}>
        {busy ? "Opening WebAuth…" : "Connect WebAuth (testnet)"}
      </button>
      {error ? (
        <p className="bad" style={{ marginTop: 16 }}>
          {error}
        </p>
      ) : null}
      <p className="faint mono" style={{ marginTop: 26, fontSize: 11, letterSpacing: 2 }}>
        XPR NETWORK TESTNET · CONTRACT xprconf · NO WALLET CHANGES NEEDED
      </p>
    </div>
  </div>
);
