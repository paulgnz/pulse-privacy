// Arithmetic in the bn254 scalar field (the Baby Jubjub base field and the Poseidon field),
// done natively in WebAssembly rather than through the `mod_exp` host function.
// Elements are 8 little-endian 32-bit limbs in Montgomery form (x·R mod r, R = 2^256).
// Multiplication is CIOS Montgomery with 32-bit words; every routine writes into a caller-owned
// buffer so hashing allocates nothing per round.
import { MODULUS, N0INV, ONE, R2, SQRT_EXP, SQRT_S, SQRT_Z } from "./poseidon_consts";

export type Limbs = StaticArray<u32>;

export function zero(): Limbs {
  return new StaticArray<u32>(8);
}

function ge(a: Limbs, b: u32[]): bool {
  for (let i = 7; i >= 0; i--) {
    const x = unchecked(a[i]);
    const y = unchecked(b[i]);
    if (x != y) return x > y;
  }
  return true;
}

function subModulus(a: Limbs): void {
  let borrow: u64 = 0;
  for (let i = 0; i < 8; i++) {
    const d: u64 = (unchecked(a[i]) as u64) - (unchecked(MODULUS[i]) as u64) - borrow;
    unchecked((a[i] = d as u32));
    borrow = (d >> 63) & 1;
  }
}

/** out = a + b mod r (a, b reduced) */
export function add(out: Limbs, a: Limbs, b: Limbs): void {
  let carry: u64 = 0;
  for (let i = 0; i < 8; i++) {
    const s: u64 = (unchecked(a[i]) as u64) + (unchecked(b[i]) as u64) + carry;
    unchecked((out[i] = s as u32));
    carry = s >> 32;
  }
  // a + b < 2r < 2^255, so no carry out of the top limb; one conditional subtraction reduces
  if (ge(out, MODULUS)) subModulus(out);
}

/** out = a · b · R⁻¹ mod r  (Montgomery product; inputs and output in Montgomery form) */
export function mul(out: Limbs, a: Limbs, b: Limbs): void {
  let t0: u64 = 0, t1: u64 = 0, t2: u64 = 0, t3: u64 = 0, t4: u64 = 0, t5: u64 = 0, t6: u64 = 0, t7: u64 = 0, t8: u64 = 0, t9: u64 = 0;
  for (let i = 0; i < 8; i++) {
    const bi: u64 = unchecked(b[i]) as u64;
    let c: u64 = 0;
    let s: u64;
    s = t0 + (unchecked(a[0]) as u64) * bi; t0 = s & 0xffffffff; c = s >> 32;
    s = t1 + (unchecked(a[1]) as u64) * bi + c; t1 = s & 0xffffffff; c = s >> 32;
    s = t2 + (unchecked(a[2]) as u64) * bi + c; t2 = s & 0xffffffff; c = s >> 32;
    s = t3 + (unchecked(a[3]) as u64) * bi + c; t3 = s & 0xffffffff; c = s >> 32;
    s = t4 + (unchecked(a[4]) as u64) * bi + c; t4 = s & 0xffffffff; c = s >> 32;
    s = t5 + (unchecked(a[5]) as u64) * bi + c; t5 = s & 0xffffffff; c = s >> 32;
    s = t6 + (unchecked(a[6]) as u64) * bi + c; t6 = s & 0xffffffff; c = s >> 32;
    s = t7 + (unchecked(a[7]) as u64) * bi + c; t7 = s & 0xffffffff; c = s >> 32;
    s = t8 + c; t8 = s & 0xffffffff; t9 = s >> 32;

    const m: u64 = (t0 * (N0INV as u64)) & 0xffffffff;
    s = t0 + m * (unchecked(MODULUS[0]) as u64); c = s >> 32;
    s = t1 + m * (unchecked(MODULUS[1]) as u64) + c; t0 = s & 0xffffffff; c = s >> 32;
    s = t2 + m * (unchecked(MODULUS[2]) as u64) + c; t1 = s & 0xffffffff; c = s >> 32;
    s = t3 + m * (unchecked(MODULUS[3]) as u64) + c; t2 = s & 0xffffffff; c = s >> 32;
    s = t4 + m * (unchecked(MODULUS[4]) as u64) + c; t3 = s & 0xffffffff; c = s >> 32;
    s = t5 + m * (unchecked(MODULUS[5]) as u64) + c; t4 = s & 0xffffffff; c = s >> 32;
    s = t6 + m * (unchecked(MODULUS[6]) as u64) + c; t5 = s & 0xffffffff; c = s >> 32;
    s = t7 + m * (unchecked(MODULUS[7]) as u64) + c; t6 = s & 0xffffffff; c = s >> 32;
    s = t8 + c; t7 = s & 0xffffffff; c = s >> 32;
    t8 = t9 + c;
  }
  unchecked((out[0] = t0 as u32)); unchecked((out[1] = t1 as u32)); unchecked((out[2] = t2 as u32)); unchecked((out[3] = t3 as u32));
  unchecked((out[4] = t4 as u32)); unchecked((out[5] = t5 as u32)); unchecked((out[6] = t6 as u32)); unchecked((out[7] = t7 as u32));
  // t8 is 0 or 1; r < 2^254 so the value is below 2r and one subtraction reduces
  if (t8 != 0 || ge(out, MODULUS)) subModulus(out);
}

/** out = a · c where c is a Montgomery-form constant stored flat in `table` at element `idx` */
export function mulConst(out: Limbs, a: Limbs, table: u32[], idx: i32): void {
  const base = idx << 3;
  let t0: u64 = 0, t1: u64 = 0, t2: u64 = 0, t3: u64 = 0, t4: u64 = 0, t5: u64 = 0, t6: u64 = 0, t7: u64 = 0, t8: u64 = 0, t9: u64 = 0;
  for (let i = 0; i < 8; i++) {
    const bi: u64 = unchecked(table[base + i]) as u64;
    let c: u64 = 0;
    let s: u64;
    s = t0 + (unchecked(a[0]) as u64) * bi; t0 = s & 0xffffffff; c = s >> 32;
    s = t1 + (unchecked(a[1]) as u64) * bi + c; t1 = s & 0xffffffff; c = s >> 32;
    s = t2 + (unchecked(a[2]) as u64) * bi + c; t2 = s & 0xffffffff; c = s >> 32;
    s = t3 + (unchecked(a[3]) as u64) * bi + c; t3 = s & 0xffffffff; c = s >> 32;
    s = t4 + (unchecked(a[4]) as u64) * bi + c; t4 = s & 0xffffffff; c = s >> 32;
    s = t5 + (unchecked(a[5]) as u64) * bi + c; t5 = s & 0xffffffff; c = s >> 32;
    s = t6 + (unchecked(a[6]) as u64) * bi + c; t6 = s & 0xffffffff; c = s >> 32;
    s = t7 + (unchecked(a[7]) as u64) * bi + c; t7 = s & 0xffffffff; c = s >> 32;
    s = t8 + c; t8 = s & 0xffffffff; t9 = s >> 32;

    const m: u64 = (t0 * (N0INV as u64)) & 0xffffffff;
    s = t0 + m * (unchecked(MODULUS[0]) as u64); c = s >> 32;
    s = t1 + m * (unchecked(MODULUS[1]) as u64) + c; t0 = s & 0xffffffff; c = s >> 32;
    s = t2 + m * (unchecked(MODULUS[2]) as u64) + c; t1 = s & 0xffffffff; c = s >> 32;
    s = t3 + m * (unchecked(MODULUS[3]) as u64) + c; t2 = s & 0xffffffff; c = s >> 32;
    s = t4 + m * (unchecked(MODULUS[4]) as u64) + c; t3 = s & 0xffffffff; c = s >> 32;
    s = t5 + m * (unchecked(MODULUS[5]) as u64) + c; t4 = s & 0xffffffff; c = s >> 32;
    s = t6 + m * (unchecked(MODULUS[6]) as u64) + c; t5 = s & 0xffffffff; c = s >> 32;
    s = t7 + m * (unchecked(MODULUS[7]) as u64) + c; t6 = s & 0xffffffff; c = s >> 32;
    s = t8 + c; t7 = s & 0xffffffff; c = s >> 32;
    t8 = t9 + c;
  }
  unchecked((out[0] = t0 as u32)); unchecked((out[1] = t1 as u32)); unchecked((out[2] = t2 as u32)); unchecked((out[3] = t3 as u32));
  unchecked((out[4] = t4 as u32)); unchecked((out[5] = t5 as u32)); unchecked((out[6] = t6 as u32)); unchecked((out[7] = t7 as u32));
  if (t8 != 0 || ge(out, MODULUS)) subModulus(out);
}

/** out = a + c (constant from a flat table) */
export function addConst(out: Limbs, a: Limbs, table: u32[], idx: i32): void {
  const base = idx << 3;
  let carry: u64 = 0;
  for (let i = 0; i < 8; i++) {
    const s: u64 = (unchecked(a[i]) as u64) + (unchecked(table[base + i]) as u64) + carry;
    unchecked((out[i] = s as u32));
    carry = s >> 32;
  }
  if (ge(out, MODULUS)) subModulus(out);
}

export function copy(out: Limbs, a: Limbs): void {
  for (let i = 0; i < 8; i++) unchecked((out[i] = a[i]));
}

/** out = a⁵, using `t` as scratch */
export function pow5(out: Limbs, a: Limbs, t: Limbs): void {
  mul(t, a, a);
  mul(t, t, t);
  mul(out, t, a);
}

/** big-endian 32 bytes (a reduced integer) → Montgomery form */
export function fromBytesBE(b: u8[], off: i32): Limbs {
  const raw = new StaticArray<u32>(8);
  for (let i = 0; i < 8; i++) {
    const p = off + 28 - 4 * i;
    unchecked((raw[i] = ((b[p] as u32) << 24) | ((b[p + 1] as u32) << 16) | ((b[p + 2] as u32) << 8) | (b[p + 3] as u32)));
  }
  const r2 = new StaticArray<u32>(8);
  for (let i = 0; i < 8; i++) unchecked((r2[i] = R2[i]));
  const out = new StaticArray<u32>(8);
  mul(out, raw, r2);
  return out;
}

/** unsigned 64-bit integer → Montgomery form */
export function fromU64(v: u64): Limbs {
  const raw = new StaticArray<u32>(8);
  unchecked((raw[0] = v as u32));
  unchecked((raw[1] = (v >> 32) as u32));
  const r2 = new StaticArray<u32>(8);
  for (let i = 0; i < 8; i++) unchecked((r2[i] = R2[i]));
  const out = new StaticArray<u32>(8);
  mul(out, raw, r2);
  return out;
}

/** Montgomery form → big-endian 32 bytes of the reduced integer */
export function toBytesBE(a: Limbs): u8[] {
  const one = new StaticArray<u32>(8);
  unchecked((one[0] = 1));
  const raw = new StaticArray<u32>(8);
  mul(raw, a, one);
  const out = new Array<u8>(32);
  for (let i = 0; i < 8; i++) {
    const w = unchecked(raw[i]);
    const p = 28 - 4 * i;
    out[p] = (w >> 24) as u8; out[p + 1] = (w >> 16) as u8; out[p + 2] = (w >> 8) as u8; out[p + 3] = w as u8;
  }
  return out;
}

/** the integer is below the modulus (for validating inputs) */
export function isCanonicalBE(b: u8[], off: i32): bool {
  for (let i = 7; i >= 0; i--) {
    const p = off + 28 - 4 * i;
    const w: u32 = ((b[p] as u32) << 24) | ((b[p + 1] as u32) << 16) | ((b[p + 2] as u32) << 8) | (b[p + 3] as u32);
    const m = unchecked(MODULUS[i]);
    if (w != m) return w < m;
  }
  return false;
}

export function hex(b: u8[]): string {
  const digits = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < b.length; i++) out += digits.charAt(b[i] >> 4) + digits.charAt(b[i] & 15);
  return out;
}

export function eq(a: Limbs, b: Limbs): bool {
  for (let i = 0; i < 8; i++) if (unchecked(a[i]) != unchecked(b[i])) return false;
  return true;
}
function fromTable(table: u32[], idx: i32 = 0): Limbs {
  const out = new StaticArray<u32>(8);
  for (let i = 0; i < 8; i++) unchecked((out[i] = table[(idx << 3) + i]));
  return out;
}
/** out = a^e with e a plain 256-bit integer given as little-endian limbs (square-and-multiply) */
export function powLimbs(out: Limbs, a: Limbs, e: u32[]): void {
  const acc = fromTable(ONE);
  const base = zero();
  copy(base, a);
  const t = zero();
  for (let i = 0; i < 8; i++) {
    let w = unchecked(e[i]);
    for (let b = 0; b < 32; b++) {
      if (w & 1) { mul(t, acc, base); copy(acc, t); }
      mul(t, base, base); copy(base, t);
      w >>= 1;
    }
  }
  copy(out, acc);
}
/** out = a⁻¹ (Fermat: a^(r−2)); a must be non-zero */
export function inv(out: Limbs, a: Limbs): void {
  const e = new Array<u32>(8);
  for (let i = 0; i < 8; i++) e[i] = unchecked(MODULUS[i]);
  e[0] -= 2; // the low limb of r is 0xf0000001, so no borrow
  powLimbs(out, a, e);
}
/** out = √a (Tonelli–Shanks, r − 1 = 2^28·S); returns false if a is a non-residue */
export function sqrt(out: Limbs, a: Limbs): bool {
  const one = fromTable(ONE);
  const zeroL = zero();
  if (eq(a, zeroL)) { copy(out, zeroL); return true; }
  let m = 28;
  const c = fromTable(SQRT_Z);
  const t = zero();
  powLimbs(t, a, SQRT_S);
  const r = zero();
  powLimbs(r, a, SQRT_EXP);
  const tmp = zero();
  const b = zero();
  for (;;) {
    if (eq(t, one)) { copy(out, r); return true; }
    // least i with t^(2^i) == 1
    let i = 0;
    copy(tmp, t);
    while (!eq(tmp, one)) {
      mul(tmp, tmp, tmp);
      i++;
      if (i == m) return false;
    }
    // b = c^(2^(m−i−1))
    copy(b, c);
    for (let k = 0; k < m - i - 1; k++) { mul(tmp, b, b); copy(b, tmp); }
    m = i;
    mul(c, b, b);
    mul(tmp, t, c); copy(t, tmp);
    mul(tmp, r, b); copy(r, tmp);
  }
  return false;
}
/** out = −a */
export function neg(out: Limbs, a: Limbs): void {
  const z = zero();
  if (eq(a, z)) { copy(out, z); return; }
  // r − a, computed on plain integers: MODULUS − a where a is in Montgomery form is still a
  // valid Montgomery element (negation commutes with the Montgomery map)
  let borrow: u64 = 0;
  for (let i = 0; i < 8; i++) {
    const d: u64 = (unchecked(MODULUS[i]) as u64) - (unchecked(a[i]) as u64) - borrow;
    unchecked((out[i] = d as u32));
    borrow = (d >> 63) & 1;
  }
}
/** parity of the integer an element represents */
export function isOdd(a: Limbs): bool {
  return (toBytesBE(a)[31] & 1) == 1;
}
