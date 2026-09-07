import type { ReactNode } from "react";
import type { EdgeCheck } from "../lib/privacy";
import { fmtUnits } from "../lib/format";

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
  placeholder = "0.0000",
  autoFocus,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
}) => (
  <div className="amount-input">
    <input id={id} className="num" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode="decimal" autoFocus={autoFocus} />
    <span className="unit">XPR</span>
  </div>
);

export const Note = ({ level, children }: { level: "ok" | "info" | "warn" | "error"; children: ReactNode }) => (
  <div className={`note ${level}`} role={level === "error" ? "alert" : undefined}>
    {children}
  </div>
);

export const EdgeNote = ({ check, onSuggest }: { check: EdgeCheck; onSuggest?: (amount: bigint) => void }) => {
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
              Use {fmtUnits(check.suggestedAmount, { trim: true })} XPR instead
            </button>
          ) : null}
          {check.suggestedDelayHours ? <span>or wait about {check.suggestedDelayHours} hours and let the pool move first.</span> : null}
        </div>
      ) : null}
    </Note>
  );
};

export const Progress = ({ fraction, stage }: { fraction: number; stage: string }) => (
  <div className="progress" aria-live="polite">
    <div className="bar">
      <i style={{ width: `${Math.round(fraction * 100)}%` }} />
    </div>
    <div className="stage">{stage}</div>
  </div>
);

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
