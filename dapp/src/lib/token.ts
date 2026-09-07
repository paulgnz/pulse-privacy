// A confidential token as the contract sees it: one `config` row per Antelope symbol.
// The contract scopes `accounts` (and keys `config` / `limits`) by the symbol's raw value:
// precision in the low byte, the code's characters above it, little-endian.

export interface Token {
  /** "XPR", "XMD" */
  code: string;
  /** decimals */
  precision: number;
  /** "4,XPR" as the ABI `symbol` type wants it */
  symStr: string;
  /** symbol raw value as a decimal string: table scope / primary key */
  raw: string;
  /** the token contract that issues it (deposits go there) */
  contract: string;
  /** 10^precision */
  units: bigint;
}

export function encodeSymRaw(code: string, precision: number): bigint {
  let raw = BigInt(precision & 0xff);
  for (let i = 0; i < code.length; i++) raw |= BigInt(code.charCodeAt(i)) << BigInt(8 * (i + 1));
  return raw;
}

export function decodeSymRaw(raw: string | number | bigint): { code: string; precision: number } {
  let v = BigInt(raw);
  const precision = Number(v & 0xffn);
  v >>= 8n;
  let code = "";
  while (v > 0n) {
    code += String.fromCharCode(Number(v & 0xffn));
    v >>= 8n;
  }
  return { code, precision };
}

export function makeToken(code: string, precision: number, contract: string): Token {
  return { code, precision, symStr: `${precision},${code}`, raw: encodeSymRaw(code, precision).toString(), contract, units: 10n ** BigInt(precision) };
}

/** from a `config` table row */
export function tokenFromRaw(raw: string | number | bigint, contract: string): Token {
  const { code, precision } = decodeSymRaw(raw);
  return makeToken(code, precision, contract);
}

/** XPR: the token every deployment has; used before the config table has been read */
export const XPR: Token = makeToken("XPR", 4, "eosio.token");
/** Metal Dollar as issued on mainnet (the simulation lists it too) */
export const XMD: Token = makeToken("XMD", 6, "xmd.token");

/** XPR first, then the rest alphabetically */
export function sortTokens(tokens: Token[]): Token[] {
  return [...tokens].sort((a, b) => (a.code === "XPR" ? -1 : b.code === "XPR" ? 1 : a.code.localeCompare(b.code)));
}

const TOKEN_KEY = "pulse-privacy/token";
export function rememberToken(code: string) {
  try {
    localStorage.setItem(TOKEN_KEY, code);
  } catch {
    /* ignore */
  }
}
export function rememberedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
