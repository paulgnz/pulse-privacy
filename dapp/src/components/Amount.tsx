import { fmtUnits } from "../lib/format";

/**
 * An amount on a statement. Public amounts print as figures. Hidden amounts print as a
 * redaction bar sized to the digits they hide; `revealed` lifts the bar to show the figures.
 */
export const Amount = ({
  value,
  hidden = false,
  revealed = false,
  size = "plain",
  sign,
  unit = true,
  tone,
  digits,
}: {
  value?: bigint;
  /** hidden on chain: draw a bar unless revealed */
  hidden?: boolean;
  /** the viewer can read it and chose to */
  revealed?: boolean;
  size?: "plain" | "mid" | "big";
  /** "+" | "−" prefix */
  sign?: "+" | "−";
  unit?: boolean;
  tone?: "auditor";
  /** width of the bar when the value is unknown, in characters */
  digits?: number;
}) => {
  const show = !hidden || (revealed && value !== undefined);
  const text = value === undefined ? "" : fmtUnits(value);
  const cls = `figure ${size} ${hidden && show ? "reveal" : ""} ${tone === "auditor" ? "auditor-only" : ""}`;
  if (show) {
    return (
      <span className={cls}>
        <span className="digits">
          {sign ?? ""}
          {text}
        </span>
        {unit ? <span className="unit">XPR</span> : null}
      </span>
    );
  }
  const n = digits ?? (text ? text.length : 9);
  return (
    <span className={cls}>
      <span className="redact private" style={{ width: `${Math.max(3, n) * 0.62}em` }} role="img" aria-label="hidden amount" />
      {unit ? <span className="unit">XPR</span> : null}
    </span>
  );
};
