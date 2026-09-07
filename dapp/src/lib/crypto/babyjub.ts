// Baby Jubjub (twisted Edwards over the bn254 scalar field) in plain bigint, browser-only.
// Matches circomlibjs / circuits/transfer/transfer.circom exactly (verified by
// scripts/crosscheck.mjs). Affine points; batch inversion for the BSGS table.

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const A = 168700n;
export const D = 168696n;
/** prime-order subgroup order l */
export const L = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

export type Pt = [bigint, bigint];
export const INF: Pt = [0n, 1n];
// G = circomlib Base8; H = hash-to-curve("pulse-privacy/babyjubjub/H/v1") (circuits/lib/generators.json)
export const G: Pt = [5299619240641551281634865583518297030282874472190772894086521144482721001553n, 16950150798460657717958625567821834550301663161624707787222815936182638968203n];
export const H: Pt = [10420574703805908794635466290298695303512362146808873567118197235464432808399n, 8041688843582100057310330549133454815056643798262112335528523571820178063556n];

const mod = (a: bigint, m = P) => ((a % m) + m) % m;
export const fadd = (a: bigint, b: bigint) => { const s = a + b; return s >= P ? s - P : s; };
export const fsub = (a: bigint, b: bigint) => { const s = a - b; return s < 0n ? s + P : s; };
export const fmul = (a: bigint, b: bigint) => (a * b) % P;

/** modular inverse via extended Euclid (fast on bigint) */
export function finv(a: bigint, m = P): bigint {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error("not invertible");
  return mod(old_s, m);
}

export function add(p1: Pt, p2: Pt): Pt {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const x1y2 = fmul(x1, y2);
  const y1x2 = fmul(y1, x2);
  const x1x2 = fmul(x1, x2);
  const y1y2 = fmul(y1, y2);
  const dxy = fmul(D, fmul(x1x2, y1y2));
  const x3 = fmul(fadd(x1y2, y1x2), finv(fadd(1n, dxy)));
  const y3 = fmul(fsub(y1y2, fmul(A, x1x2)), finv(fsub(1n, dxy)));
  return [x3, y3];
}

export const neg = (p: Pt): Pt => [fsub(0n, p[0]), p[1]];
export const eq = (p: Pt, q: Pt) => p[0] === q[0] && p[1] === q[1];

/** k·p, double-and-add (k reduced mod l first) */
export function mul(p: Pt, k: bigint): Pt {
  let n = mod(k, L);
  let acc: Pt = INF;
  let base = p;
  while (n > 0n) {
    if (n & 1n) acc = add(acc, base);
    base = add(base, base);
    n >>= 1n;
  }
  return acc;
}

export function onCurve(p: Pt): boolean {
  const [x, y] = p;
  if (x < 0n || x >= P || y < 0n || y >= P) return false;
  const x2 = fmul(x, x);
  const y2 = fmul(y, y);
  return fadd(fmul(A, x2), y2) === fadd(1n, fmul(D, fmul(x2, y2)));
}

// --- extended coordinates (X, Y, Z, T) with X/Z, Y/Z affine, T = XY/Z: no inversion per add ---
type Ext = [bigint, bigint, bigint, bigint];
const toExt = (p: Pt): Ext => [p[0], p[1], 1n, fmul(p[0], p[1])];
function extAdd(p: Ext, q: Ext): Ext {
  // unified addition for a·x²+y² = 1 + d·x²y² ("add-2008-hwcd")
  const [X1, Y1, Z1, T1] = p;
  const [X2, Y2, Z2, T2] = q;
  const a = fmul(X1, X2);
  const b = fmul(Y1, Y2);
  const c = fmul(fmul(D, T1), T2);
  const d = fmul(Z1, Z2);
  const e = fsub(fsub(fmul(fadd(X1, Y1), fadd(X2, Y2)), a), b);
  const f = fsub(d, c);
  const g = fadd(d, c);
  const h = fsub(b, fmul(A, a));
  return [fmul(e, f), fmul(g, h), fmul(f, g), fmul(e, h)];
}
/** batch-normalise extended points to affine with one inversion (Montgomery trick) */
function normalize(pts: Ext[]): Pt[] {
  const n = pts.length;
  const prefix = new Array<bigint>(n);
  let acc = 1n;
  for (let i = 0; i < n; i++) {
    prefix[i] = acc;
    acc = fmul(acc, pts[i][2]);
  }
  let inv = finv(acc);
  const out = new Array<Pt>(n);
  for (let i = n - 1; i >= 0; i--) {
    const zi = fmul(inv, prefix[i]);
    inv = fmul(inv, pts[i][2]);
    out[i] = [fmul(pts[i][0], zi), fmul(pts[i][1], zi)];
  }
  return out;
}

// --- BSGS over [0, 2^32) with a 2^16 baby table (keyed by "x,y") ---
const BABY = 1 << 16;
let table: Map<string, number> | null = null;
const key = (p: Pt) => `${p[0]},${p[1]}`;

export function buildBabyTable(onProgress?: (f: number) => void): Map<string, number> {
  if (table) return table;
  const t = new Map<string, number>();
  const g = toExt(G);
  let cur: Ext = [0n, 1n, 1n, 0n];
  const CH = 4096;
  for (let base = 0; base < BABY; base += CH) {
    const batch: Ext[] = [];
    for (let i = 0; i < CH; i++) {
      batch.push(cur);
      cur = extAdd(cur, g);
    }
    const aff = normalize(batch);
    for (let i = 0; i < CH; i++) t.set(key(aff[i]), base + i);
    onProgress?.((base + CH) / BABY);
  }
  table = t;
  return t;
}

/** discrete log of `point` base G in [0, 2^bits); bits ≤ 40 (beyond 32 it is slow) */
export function bsgs(point: Pt, bits = 32): bigint {
  const t = buildBabyTable();
  const giants = 1 << (bits - 16);
  const negGiant = toExt(neg(mul(G, BigInt(BABY))));
  let cur = toExt(point);
  const CH = 4096;
  for (let base = 0; base < giants; base += CH) {
    const batch: Ext[] = [];
    const n = Math.min(CH, giants - base);
    for (let i = 0; i < n; i++) {
      batch.push(cur);
      cur = extAdd(cur, negGiant);
    }
    const aff = normalize(batch);
    for (let i = 0; i < n; i++) {
      const hit = t.get(key(aff[i]));
      if (hit !== undefined) return BigInt(hit) + (BigInt(base + i) << 16n);
    }
  }
  throw new Error(`bsgs: value not in [0, 2^${bits})`);
}

// --- randomness ---
export function randScalar(): bigint {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  const x = BigInt("0x" + Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("")) % L;
  return x === 0n ? 1n : x;
}

// --- hex helpers (bare hex, big-endian 32-byte words) ---
export const w32 = (n: bigint) => n.toString(16).padStart(64, "0");
export const ptHex = (p: Pt) => w32(p[0]) + w32(p[1]);
export function ptFromHex(h: string, off = 0): Pt {
  const s = h.replace(/^0x/i, "").toLowerCase();
  return [BigInt("0x" + s.slice(off, off + 64)), BigInt("0x" + s.slice(off + 64, off + 128))];
}
