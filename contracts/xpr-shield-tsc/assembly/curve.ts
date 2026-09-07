// Baby Jubjub helpers over fr.ts: the on-curve check and point decompression from
// (y, parity of x) packed as a 32-byte word with the parity in the top bit.
import { check } from "proton-tsc";
import { Limbs, add, eq, fromBytesBE, fromU64, inv, isCanonicalBE, isOdd, mul, neg, sqrt, toBytesBE } from "./fr";

function bytesEq(a: u8[], b: u8[]): bool {
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
  return true;
}

/** a·x² + y² == 1 + d·x²·y², coordinates canonical, 64-byte x ‖ y */
export function onCurve(p: u8[]): bool {
  if (p.length != 64) return false;
  if (!isCanonicalBE(p, 0) || !isCanonicalBE(p, 32)) return false;
  const x = fromBytesBE(p, 0);
  const y = fromBytesBE(p, 32);
  const a = fromU64(168700);
  const d = fromU64(168696);
  const one = fromU64(1);
  const x2 = new StaticArray<u32>(8);
  const y2 = new StaticArray<u32>(8);
  const lhs = new StaticArray<u32>(8);
  const rhs = new StaticArray<u32>(8);
  mul(x2, x, x);
  mul(y2, y, y);
  mul(lhs, a, x2);
  add(lhs, lhs, y2);
  mul(rhs, x2, y2);
  mul(rhs, d, rhs);
  add(rhs, rhs, one);
  return bytesEq(toBytesBE(lhs), toBytesBE(rhs));
}

/** (y, parity of x) → x ‖ y (64 bytes); x² = (1 − y²) / (a − d·y²) */
export function decompress(w: u8[]): u8[] {
  check(w.length == 32, "compressed point must be 32 bytes");
  const parity = (w[0] & 0x80) != 0;
  const yb = w.slice(0);
  yb[0] &= 0x7f;
  check(isCanonicalBE(yb, 0), "y not canonical");
  const y = fromBytesBE(yb, 0);
  const a = fromU64(168700);
  const d = fromU64(168696);
  const one = fromU64(1);
  const y2 = new StaticArray<u32>(8);
  const num = new StaticArray<u32>(8);
  const den = new StaticArray<u32>(8);
  const x2 = new StaticArray<u32>(8);
  const x = new StaticArray<u32>(8);
  mul(y2, y, y);
  neg(num, y2); add(num, num, one);        // 1 − y²
  mul(den, d, y2); neg(den, den); add(den, den, a); // a − d·y²
  inv(den, den);
  mul(x2, num, den);
  check(sqrt(x, x2), "not a curve point");
  if (isOdd(x) != parity) neg(x, x);
  return toBytesBE(x).concat(yb);
}

/** twisted Edwards doubling in affine coordinates (a·x² + y² = 1 + d·x²·y²) */
function double(x: Limbs, y: Limbs, ox: Limbs, oy: Limbs): void {
  const a = fromU64(168700);
  const d = fromU64(168696);
  const one = fromU64(1);
  const x2 = new StaticArray<u32>(8); mul(x2, x, x);
  const y2 = new StaticArray<u32>(8); mul(y2, y, y);
  const xy = new StaticArray<u32>(8); mul(xy, x, y);
  const dxy = new StaticArray<u32>(8); mul(dxy, x2, y2); mul(dxy, d, dxy);
  // x' = 2xy / (1 + d x² y²)
  const num = new StaticArray<u32>(8); add(num, xy, xy);
  const den = new StaticArray<u32>(8); add(den, one, dxy); inv(den, den);
  mul(ox, num, den);
  // y' = (y² − a x²) / (1 − d x² y²)
  const ax2 = new StaticArray<u32>(8); mul(ax2, a, x2);
  const num2 = new StaticArray<u32>(8); neg(num2, ax2); add(num2, num2, y2);
  const den2 = new StaticArray<u32>(8); neg(den2, dxy); add(den2, den2, one); inv(den2, den2);
  mul(oy, num2, den2);
}

function isIdentity(px: Limbs, py: Limbs): bool {
  const one = fromU64(1);
  const zeroL = new StaticArray<u32>(8);
  return eq(px, zeroL) && eq(py, one);
}

/** not the identity and not a point of order 2, 4 or 8: 8·P ≠ O (the cofactor is 8) */
export function inPrimeSubgroup(p: u8[]): bool {
  let x = fromBytesBE(p, 0);
  let y = fromBytesBE(p, 32);
  if (isIdentity(x, y)) return false;
  for (let i = 0; i < 3; i++) {
    const nx = new StaticArray<u32>(8);
    const ny = new StaticArray<u32>(8);
    double(x, y, nx, ny);
    x = nx; y = ny;
  }
  return !isIdentity(x, y);
}
