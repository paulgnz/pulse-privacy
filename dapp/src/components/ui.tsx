import type { ReactNode } from "react";
import type { EdgeCheck } from "../lib/privacy";
import { fmtUnits, zeroPlaceholder } from "../lib/format";
import { XPR, type Token } from "../lib/token";

export const Field = ({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: ReactNode; children: ReactNode }) => (
  <div className="field">
    <label>{label}</label>
    {children}
    {error ? <div className="hint error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
  </div>
);

export const AmountInput = ({
  value,
  onChange,
  placeholder,
  autoFocus,
  id,
  token = XPR,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
  token?: Token;
}) => (
  <div className="amount-input">
    <input id={id} className="num" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? zeroPlaceholder(token)} inputMode="decimal" autoFocus={autoFocus} />
    <span className="unit">{token.code}</span>
  </div>
);

export const Note = ({ level, children }: { level: "ok" | "info" | "warn" | "error"; children: ReactNode }) => (
  <div className={`note ${level}`} role={level === "error" ? "alert" : undefined}>
    {children}
  </div>
);

export const EdgeNote = ({ check, onSuggest, token = XPR }: { check: EdgeCheck; onSuggest?: (amount: bigint) => void; token?: Token }) => {
  if (check.level === "ok" && !check.reasons.length) return null;
  return (
    <Note level={check.level === "warn" ? "warn" : "info"}>
      <p>{check.level === "warn" ? "This amount is easy to link to something you received." : "Worth knowing before you continue."}</p>
      <ul>
        {check.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {(check.suggestedAmount !== undefined && onSuggest) || check.suggestedDelayHours ? (
        <div className="row">
          {check.suggestedAmount !== undefined && onSuggest ? (
            <button className="textbtn" onClick={() => onSuggest(check.suggestedAmount!)}>
              Use {fmtUnits(check.suggestedAmount, token, { trim: true })} {token.code} instead
            </button>
          ) : null}
          {check.suggestedDelayHours ? <span>or wait about {check.suggestedDelayHours} hours and let the pool move first.</span> : null}
        </div>
      ) : null}
    </Note>
  );
};

/** Waiting on something outside the page (the wallet, the chain): a breathing dot and a line. */
export const Busy = ({ children }: { children: ReactNode }) => (
  <span className="busy" role="status">
    <span className="busy-dot" aria-hidden="true" />
    <span>{children}</span>
  </span>
);

export const Progress = ({ fraction, stage }: { fraction: number; stage: string }) => {
  const wait = /wait/i.test(stage); // the wallet's turn: indeterminate
  return (
    <div className={`progress ${wait ? "wait" : ""}`} aria-live="polite">
      <div className="bar">
        <i style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
      <div className="stage">{wait ? <Busy>{stage}</Busy> : stage}</div>
    </div>
  );
};

/** A statement line: label on the left, value on the right. */
export const Line = ({ label, sub, children, hero }: { label: ReactNode; sub?: ReactNode; children: ReactNode; hero?: boolean }) => (
  <div className={`line ${hero ? "hero" : ""}`}>
    <div className="label">
      {label}
      {sub ? <span className="sub">{sub}</span> : null}
    </div>
    <div className="value">{children}</div>
  </div>
);

/** Token choice inside a form: "Token  XPR  XMD" with the active one underlined. */
export const TokenPicker = ({ tokens, current, onSelect }: { tokens: { code: string }[]; current: string; onSelect: (code: string) => void }) => {
  if (tokens.length < 2) return null;
  return (
    <div className="tokpick" role="group" aria-label="Token">
      <span className="lbl">Token</span>
      {tokens.map((t) => (
        <button key={t.code} type="button" className="textbtn" onClick={() => onSelect(t.code)} aria-pressed={t.code === current}>
          {t.code}
        </button>
      ))}
    </div>
  );
};
