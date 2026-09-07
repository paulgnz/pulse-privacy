import type { ReactNode } from "react";
import type { EdgeCheck } from "../lib/privacy";
import { fmtUnits } from "../lib/format";

export const Card = ({
  children,
  accent,
  className = "",
}: {
  children: ReactNode;
  accent?: "peri" | "warm" | "good";
  className?: string;
}) => <section className={`card ${accent ? `accent-${accent}` : ""} ${className}`}>{children}</section>;

export const Tag = ({ kind, children }: { kind: "public" | "hidden" | "audit" | "bad"; children?: ReactNode }) => (
  <span className={`tag ${kind}`}>{children ?? (kind === "public" ? "PUBLIC" : kind === "hidden" ? "HIDDEN" : kind === "audit" ? "AUDITOR" : "ERROR")}</span>
);

export const Padlock = ({ size = 26, color = "#8b95ff", open = false }: { size?: number; color?: string; open?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d={open ? "M8 10V7a4 4 0 0 1 8 0" : "M8 10V7a4 4 0 0 1 8 0v3"} stroke={color} strokeWidth={2} strokeLinecap="round" />
    <rect x={5} y={10} width={14} height={11} rx={2.5} fill={color} opacity={0.92} />
    <circle cx={12} cy={15.5} r={1.6} fill="#0b101f" />
  </svg>
);

export const KeyGlyph = ({ size = 18, color = "#eef1fb" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx={8} cy={12} r={4} stroke={color} strokeWidth={2} />
    <path d="M12 12h9M18 12v3M21 12v3" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </svg>
);

export const Field = ({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) => (
  <div className="field">
    <label>{label}</label>
    {children}
    {hint ? <div className="hint">{hint}</div> : null}
  </div>
);

export const AmountInput = ({
  value,
  onChange,
  placeholder = "0.0000",
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) => (
  <div className="amount-input">
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode="decimal" autoFocus={autoFocus} />
    <span className="unit">XPR</span>
  </div>
);

export const Notice = ({
  level,
  title,
  children,
}: {
  level: "ok" | "notice" | "warn" | "bad";
  title?: string;
  children: ReactNode;
}) => (
  <div className={`notice ${level}`}>
    {title ? <div className={`title ${level === "warn" ? "warm" : level === "bad" ? "bad" : level === "ok" ? "good" : "peri"}`}>{title}</div> : null}
    {children}
  </div>
);

export const EdgeNotice = ({ check, onSuggest }: { check: EdgeCheck; onSuggest?: (amount: bigint) => void }) => {
  if (check.level === "ok" && !check.reasons.length) return null;
  return (
    <Notice level={check.level} title={check.level === "warn" ? "This withdrawal is easy to link" : "Worth knowing"}>
      <ul>
        {check.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {check.suggestedAmount !== undefined || check.suggestedDelayHours ? (
        <div className="row" style={{ marginTop: 10 }}>
          {check.suggestedAmount !== undefined && onSuggest ? (
            <button className="btn sm" onClick={() => onSuggest(check.suggestedAmount!)}>
              Use {fmtUnits(check.suggestedAmount, { trim: true })} XPR instead
            </button>
          ) : null}
          {check.suggestedDelayHours ? <span className="dim" style={{ fontSize: 13 }}>or wait about {check.suggestedDelayHours}h and let the pool move first</span> : null}
        </div>
      ) : null}
    </Notice>
  );
};

export const Progress = ({ fraction, stage }: { fraction: number; stage: string }) => (
  <div className="stack" style={{ gap: 6 }}>
    <div className="progress">
      <i style={{ width: `${Math.round(fraction * 100)}%` }} />
    </div>
    <div className="mono faint" style={{ fontSize: 11, letterSpacing: 2 }}>
      {stage.toUpperCase()}
    </div>
  </div>
);

export const Stat = ({ k, v, className = "" }: { k: string; v: ReactNode; className?: string }) => (
  <div className="stat">
    <div className={`v ${className}`}>{v}</div>
    <div className="k">{k}</div>
  </div>
);
