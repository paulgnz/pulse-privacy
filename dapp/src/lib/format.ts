import { PRECISION, SYMBOL } from "../config";

const UNIT = 10n ** BigInt(PRECISION);

/** units (bigint, 4 decimals) → "1,234.5679" */
export function fmtUnits(u: bigint, opts: { sign?: boolean; trim?: boolean } = {}): string {
  const neg = u < 0n;
  const abs = neg ? -u : u;
  const whole = abs / UNIT;
  let frac = (abs % UNIT).toString().padStart(PRECISION, "0");
  if (opts.trim) frac = frac.replace(/0+$/, "");
  const w = whole.toLocaleString("en-US");
  const s = frac.length ? `${w}.${frac}` : w;
  return (neg ? "−" : opts.sign ? "+" : "") + s;
}

/** "1,234.5679" | "1234.5" → units; throws on junk */
export function parseUnits(s: string): bigint {
  const clean = s.replace(/[,\s]/g, "");
  if (!/^\d*(\.\d*)?$/.test(clean) || clean === "" || clean === ".") throw new Error("not a number");
  const [w, f = ""] = clean.split(".");
  if (f.length > PRECISION) throw new Error(`at most ${PRECISION} decimals`);
  return BigInt(w || "0") * UNIT + BigInt((f + "0".repeat(PRECISION)).slice(0, PRECISION));
}

/** units → Antelope asset string "1234.5679 XPR" */
export function toAsset(u: bigint): string {
  const whole = u / UNIT;
  const frac = (u % UNIT).toString().padStart(PRECISION, "0");
  return `${whole}.${frac} ${SYMBOL}`;
}

/** "1234.5679 XPR" → units */
export function fromAsset(a: string): bigint {
  return parseUnits(a.split(" ")[0]);
}

export const shortHex = (h: string, n = 6) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);

export function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const UNITS = UNIT;
