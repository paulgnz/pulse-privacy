// Baby Jubjub point arithmetic in-contract, over the bn254 scalar field, built on the
// `mod_exp` host function (Leap CRYPTO_PRIMITIVES): a·b mod p = ((a+b)² − a² − b²)/2 with
// three modExp squarings, inversion = modExp(x, p−2). ~29 modExp calls per point addition.
// Used only for the homomorphic adds (pending += transfer, avail += pending) and for
// computing v·G of a PUBLIC 32-bit chunk (deposit / withdraw) from the 2^i·G table.
// The PulseVM port does this natively; here the cost is a few hundred µs per add on Leap.
import { U256, check } from "proton-tsc";
import { A_BE, D_BE, G_POW2_X, G_POW2_Y, ONE_BE, PM2_BE, P_BE } from "./consts";

// Direct binding to the host function. as-chain's `modExp` wrapper packs its inputs through
// `U256.toString(16)`, which is broken (wrong digits), so we pass big-endian bytes ourselves.
@external("env", "mod_exp")
declare function mod_exp(
  base: usize, base_len: u32, exp: usize, exp_len: u32, mod: usize, mod_len: u32, result: usize, result_len: u32
): i32;

function modExp(base: U256, exp: U256, mod: U256): U256 {
  const b = base.toBytes(true);
  const e = exp.toBytes(true);
  const m = mod.toBytes(true);
  const r = new Array<u8>(32);
  const ret = mod_exp(b.dataStart, b.length, e.dataStart, e.length, m.dataStart, m.length, r.dataStart, r.length);
  check(ret == 0, "mod_exp error");
  return U256.fromBytesBE(r);
}

/** hex of a U256 via bytes (U256.toString(16) is unreliable) */
export function hexOf(x: U256): string {
  const b = x.toBytes(true);
  const digits = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < b.length; i++) {
    out += digits.charAt(b[i] >> 4) + digits.charAt(b[i] & 15);
  }
  return out;
}

export class Pt {
  constructor(public x: U256 = U256.Zero, public y: U256 = U256.One) {}
  static inf(): Pt {
    return new Pt(U256.Zero, U256.One);
  }
  static fromBytes(a: u8[], off: i32): Pt {
    return new Pt(U256.fromBytesBE(a.slice(off, off + 32)), U256.fromBytesBE(a.slice(off + 32, off + 64)));
  }
  toBytes(): u8[] {
    return this.x.toBytes(true).concat(this.y.toBytes(true));
  }
  eq(o: Pt): bool {
    return this.x == o.x && this.y == o.y;
  }
}

function p(): U256 {
  return U256.fromBytesBE(P_BE);
}
function two(): U256 {
  return U256.fromU64(2);
}

function addm(a: U256, b: U256): U256 {
  const m = p();
  let s = a + b; // a, b < p < 2^254 → no overflow
  if (s >= m) s = s - m;
  return s;
}
function subm(a: U256, b: U256): U256 {
  return a >= b ? a - b : a + p() - b;
}
function sqm(a: U256): U256 {
  return modExp(a, two(), p());
}
function mulm(a: U256, b: U256): U256 {
  // 2ab = (a+b)² − a² − b²  (mod p), then halve
  const t = subm(subm(sqm(addm(a, b)), sqm(a)), sqm(b));
  if ((t & U256.One).isZero()) return t >> 1;
  return (t + p()) >> 1;
}
function invm(a: U256): U256 {
  return modExp(a, U256.fromBytesBE(PM2_BE), p());
}

/** twisted Edwards addition (unified; handles the identity) */
export function add(P1: Pt, P2: Pt): Pt {
  const a = U256.fromBytesBE(A_BE);
  const d = U256.fromBytesBE(D_BE);
  const one = U256.fromBytesBE(ONE_BE);
  const x1y2 = mulm(P1.x, P2.y);
  const y1x2 = mulm(P1.y, P2.x);
  const x1x2 = mulm(P1.x, P2.x);
  const y1y2 = mulm(P1.y, P2.y);
  const dxy = mulm(d, mulm(x1x2, y1y2));
  const x3 = mulm(addm(x1y2, y1x2), invm(addm(one, dxy)));
  const y3 = mulm(subm(y1y2, mulm(a, x1x2)), invm(subm(one, dxy)));
  return new Pt(x3, y3);
}

/** a·x² + y² == 1 + d·x²·y² and coordinates reduced */
export function onCurve(P: Pt): bool {
  const m = p();
  if (!(P.x < m) || !(P.y < m)) return false;
  const a = U256.fromBytesBE(A_BE);
  const d = U256.fromBytesBE(D_BE);
  const one = U256.fromBytesBE(ONE_BE);
  const x2 = sqm(P.x);
  const y2 = sqm(P.y);
  const lhs = addm(mulm(a, x2), y2);
  const rhs = addm(one, mulm(d, mulm(x2, y2)));
  return lhs == rhs;
}

/** v·G for a public v < 2^32, from the 2^i·G table (≤ 32 additions) */
export function mulG32(v: u64): Pt {
  let acc = Pt.inf();
  for (let i = 0; i < 32; i++) {
    if (((v >> i) & 1) == 1) {
      acc = add(acc, new Pt(U256.fromBytesBE(G_POW2_X[i]), U256.fromBytesBE(G_POW2_Y[i])));
    }
  }
  return acc;
}

/** encode a u64 as a 32-byte big-endian field element */
export function u64Word(v: u64): u8[] {
  return U256.fromU64(v).toBytes(true);
}

/**
 * Compressed point: 32 bytes = y (big-endian) with bit 255 set when x > (p-1)/2.
 * Decompression needs a square root (expensive on this field), so the contract never
 * decompresses: actions carry the full point and the contract checks it against the stored form.
 */
export function compress(P: Pt): u8[] {
  const y = P.y.toBytes(true);
  const half = (p() - U256.One) >> 1;
  if (P.x > half) y[0] = y[0] | 0x80;
  return y;
}

function bytesEq(a: u8[], b: u8[]): bool {
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
  return true;
}

/** `stored` is 32 B (compressed) or 64 B (legacy full); `full` is the 64 B point supplied by the action. */
/**
 * The supplied full key must be the on-curve point the stored key names. Comparing only the
 * compressed form (y and the sign of x) would accept any x on the same side of the field, and an
 * off-curve point fed into the receiver's or auditor's handle yields a box nobody can open.
 */
export function keyMatches(stored: u8[], full: u8[]): bool {
  if (full.length != 64) return false;
  const P = Pt.fromBytes(full, 0);
  if (!onCurve(P) || P.eq(Pt.inf())) return false;
  if (stored.length == 64) return bytesEq(stored, full);
  if (stored.length != 32) return false;
  return bytesEq(compress(P), stored);
}

/** every 64-byte point in `bytes` is a canonical (coordinates < p) point on the curve */
export function allOnCurve(bytes: u8[]): bool {
  if (bytes.length % 64 != 0) return false;
  for (let i = 0; i < bytes.length; i += 64) if (!onCurve(Pt.fromBytes(bytes, i))) return false;
  return true;
}
