import { useEffect, useRef, useState, type ReactNode } from "react";
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

/** The token's coin, 20 px, from public/token-<code>.png; hidden if there is no image. */
export const TokenIcon = ({ code, size = 20 }: { code: string; size?: number }) => (
  <img
    className="tokicon"
    src={`/token-${code.toLowerCase()}.png`}
    alt=""
    width={size}
    height={size}
    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
  />
);

export const AmountInput = ({
  value,
  onChange,
  placeholder,
  autoFocus,
  id,
  token = XPR,
  tokens,
  onSelectToken,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
  token?: Token;
  /** more than one: the unit becomes a menu that switches the form's token */
  tokens?: { code: string }[];
  onSelectToken?: (code: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("mousedown", away);
    addEventListener("keydown", esc);
    return () => { removeEventListener("mousedown", away); removeEventListener("keydown", esc); };
  }, [open]);
  const menu = !!tokens && tokens.length > 1 && !!onSelectToken;
  return (
    <div className={`amount-input ${menu ? "has-menu" : ""}`} ref={wrap}>
      <input id={id} className="num" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? zeroPlaceholder(token)} inputMode="decimal" autoFocus={autoFocus} />
      {menu ? (
        <>
          <button type="button" className="unit unit-menu" onClick={() => setOpen((o: boolean) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label={`Token: ${token.code}`}>
            <TokenIcon code={token.code} size={18} />
            {token.code}
            <span className="chev" aria-hidden="true" />
          </button>
          {open ? (
            <ul className="unit-list" role="listbox" aria-label="Token">
              {tokens!.map((t) => (
                <li key={t.code} role="option" aria-selected={t.code === token.code}>
                  <button type="button" onClick={() => { onSelectToken!(t.code); setOpen(false); }}>
                    <TokenIcon code={t.code} size={18} />
                    {t.code}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <span className="unit">{token.code}</span>
      )}
    </div>
  );
};

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
/** A short explanation behind a "Why…?" toggle; works on touch, unlike a hover tooltip. */
export const Explain = ({ label, children }: { label: string; children: ReactNode }) => (
  <details className="explain">
    <summary>{label}</summary>
    <div className="body">{children}</div>
  </details>
);

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
          <TokenIcon code={t.code} size={16} />
          {t.code}
        </button>
      ))}
    </div>
  );
};
