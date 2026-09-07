import { XPR, type Token } from "./token";

/** a Token or a bare precision */
type Prec = Token | number;
const precOf = (p: Prec) => (typeof p === "number" ? p : p.precision);
const unitOf = (p: Prec) => 10n ** BigInt(precOf(p));

/** units (bigint) → "1,234.5679" at the token's precision */
export function fmtUnits(u: bigint, token: Prec = XPR, opts: { sign?: boolean; trim?: boolean } = {}): string {
  const precision = precOf(token);
  const unit = unitOf(token);
  const neg = u < 0n;
  const abs = neg ? -u : u;
  const whole = abs / unit;
  let frac = precision ? (abs % unit).toString().padStart(precision, "0") : "";
  if (opts.trim) frac = frac.replace(/0+$/, "");
  const w = whole.toLocaleString("en-US");
  const s = frac.length ? `${w}.${frac}` : w;
  return (neg ? "−" : opts.sign ? "+" : "") + s;
}

/** "1,234.5679" | "1234.5" → units at the token's precision; throws on junk */
export function parseUnits(s: string, token: Prec = XPR): bigint {
  const precision = precOf(token);
  const unit = unitOf(token);
  const clean = s.replace(/[,\s]/g, "");
  if (!/^\d*(\.\d*)?$/.test(clean) || clean === "" || clean === ".") throw new Error("not a number");
  const [w, f = ""] = clean.split(".");
  if (f.length > precision) throw new Error(`at most ${precision} decimals`);
  return BigInt(w || "0") * unit + BigInt((f + "0".repeat(precision)).slice(0, precision));
}

/** Why an amount string is not accepted, in the user's words; null when it parses (or is empty). */
export function amountProblem(s: string, token: Prec = XPR): string | null {
  if (!s.trim()) return null;
  try {
    parseUnits(s, token);
    return null;
  } catch (e) {
    const precision = precOf(token);
    const code = "code" in token ? (token as Token).code : "this token";
    if (String((e as Error).message).startsWith("at most")) return `${code} has ${precision} decimal places. Use at most ${precision} digits after the point.`;
    return "Enter a number, like 12.5.";
  }
}

/** units → Antelope asset string "1234.5679 XPR" */
export function toAsset(u: bigint, token: Token = XPR): string {
  const whole = u / token.units;
  const frac = token.precision ? "." + (u % token.units).toString().padStart(token.precision, "0") : "";
  return `${whole}${frac} ${token.code}`;
}

/** "1234.5679 XPR" → units, at the precision the string itself carries */
export function fromAsset(a: string): bigint {
  const [num] = a.split(" ");
  const decimals = num.includes(".") ? num.split(".")[1].length : 0;
  return parseUnits(num, decimals);
}

/** the symbol code of an asset string ("1.0 XPR" → "XPR") */
export const assetCode = (a: string) => a.trim().split(" ")[1] ?? "";

/** placeholder for an amount input: "0.0000" at the token's precision */
export const zeroPlaceholder = (token: Prec = XPR) => (precOf(token) ? `0.${"0".repeat(precOf(token))}` : "0");

export const shortHex = (h: string, n = 6) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);

export function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** XPR units (kept for the simulation's seed amounts) */
export const UNITS = XPR.units;
