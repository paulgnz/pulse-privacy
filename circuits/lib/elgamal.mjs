// Twisted ElGamal on Baby Jubjub — client side (wallet / dapp / auditor). Pure JS, uses
// circomlibjs for the curve. Matches transfer/transfer.circom exactly.
//
//   keygen()            -> { s, P }            P = s^-1 * H
//   encrypt(v, r, pubs) -> { C, D: {...} }     C = v*G + r*H, D_X = r*P_X   (v < 2^32 here)
//   decryptPoint(C, D, s) -> v*G
//   bsgs32(point)       -> v in [0, 2^32)      baby-step giant-step, 2^16 table (cached)
//   split64 / join64    -> lo/hi 32-bit chunks
//   buildTransferWitness(...) -> circuit input object
import { buildBabyjub } from "circomlibjs";
import { F1Field } from "ffjavascript";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN = JSON.parse(readFileSync(join(HERE, "generators.json"), "utf8"));

let bj, F, Fl, G, H, INF;

export async function init() {
  if (bj) return api;
  bj = await buildBabyjub();
  F = bj.F;
  Fl = new F1Field(bj.subOrder); // scalar field (subgroup order l)
  G = [F.e(GEN.G[0]), F.e(GEN.G[1])];
  H = [F.e(GEN.H[0]), F.e(GEN.H[1])];
  INF = [F.zero, F.one]; // identity in twisted Edwards
  return api;
}

const TWO32 = 1n << 32n;
export const split64 = (v) => [BigInt(v) % TWO32, BigInt(v) / TWO32];
export const join64 = (lo, hi) => BigInt(lo) + TWO32 * BigInt(hi);

export function randScalar() {
  // uniform-ish in [1, l): 32 random bytes reduced mod l (bias negligible for this purpose)
  const x = BigInt("0x" + randomBytes(32).toString("hex")) % bj.subOrder;
  return x === 0n ? 1n : x;
}

export const toObj = (p) => [F.toObject(p[0]), F.toObject(p[1])]; // -> [bigint, bigint]
export const toPt = (o) => [F.e(o[0]), F.e(o[1])];
const mul = (p, k) => bj.mulPointEscalar(p, BigInt(k));
const add = (p, q) => bj.addPoint(p, q);
const neg = (p) => [F.neg(p[0]), p[1]];

export function keygen(s) {
  s = s === undefined ? randScalar() : BigInt(s);
  const sInv = Fl.inv(Fl.e(s));
  const P = mul(H, sInv);
  return { s, P };
}

/** v < 2^32 (one chunk). pubs: { name: point }. Returns points as circomlibjs field points. */
export function encrypt(v, r, pubs) {
  const C = add(mul(G, v), mul(H, r));
  const D = {};
  for (const k of Object.keys(pubs)) D[k] = mul(pubs[k], r);
  return { C, D };
}

/** deterministic "deposit" encryption: r = 0 → C = v*G, D = identity */
export const encryptPublic = (v) => ({ C: mul(G, v), D: INF });

/** C - s*D = v*G */
export function decryptPoint(C, D, s) {
  return add(C, neg(mul(D, s)));
}

// --- BSGS over [0, 2^32): baby table of 2^16 multiples of G, keyed by x-coordinate ---
let babyTable = null;
export function buildBabyTable() {
  if (babyTable) return babyTable;
  const t = new Map();
  let cur = INF;
  for (let i = 0; i < 1 << 16; i++) {
    t.set(F.toString(cur[0]) + "," + F.toString(cur[1]), i);
    cur = add(cur, G);
  }
  babyTable = t;
  return t;
}

export function bsgs32(point) {
  const t = buildBabyTable();
  const giant = mul(G, 1n << 16n);
  const negGiant = neg(giant);
  let cur = point;
  for (let j = 0; j < 1 << 16; j++) {
    const hit = t.get(F.toString(cur[0]) + "," + F.toString(cur[1]));
    if (hit !== undefined) return BigInt(hit) + (BigInt(j) << 16n);
    cur = add(cur, negGiant);
  }
  throw new Error("bsgs32: value not in [0, 2^32)");
}

/** decrypt a full 64-bit amount from two chunk ciphertexts (each {C, D}) */
export function decrypt64(ct, s) {
  const lo = bsgs32(decryptPoint(ct[0].C, ct[0].D, s));
  const hi = bsgs32(decryptPoint(ct[1].C, ct[1].D, s));
  return join64(lo, hi);
}

/** homomorphic add of two chunk ciphertexts */
export const ctAdd = (a, b) => ({ C: add(a.C, b.C), D: add(a.D, b.D) });

/**
 * Build the circuit input for one transfer.
 *  sender: { s, P }, receiverP, auditorP: points
 *  bold: [{C, D}, {C, D}] sender's on-record balance chunks; voldChunks: [lo, hi] plaintext (may be un-normalised)
 *  v: amount (bigint < 2^64); nonce/senderName/receiverName: bigint field elements
 * Returns { input, T, Bnew } where T/Bnew hold the fresh ciphertexts (as field points).
 */
export function buildTransferWitness({ sender, receiverP, auditorP, bold, voldChunks, v, nonce, senderName, receiverName }) {
  const vOld = join64(voldChunks[0], voldChunks[1]);
  if (BigInt(v) > vOld) throw new Error("insufficient balance");
  const vNew = vOld - BigInt(v);
  const vC = split64(v);
  const nC = split64(vNew);
  const rT = [randScalar(), randScalar()];
  const rN = [randScalar(), randScalar()];
  const T = [0, 1].map((k) => encrypt(vC[k], rT[k], { s: sender.P, r: receiverP, a: auditorP }));
  const Bnew = [0, 1].map((k) => encrypt(nC[k], rN[k], { s: sender.P }));
  const P2 = (p) => toObj(p).map(String);
  const input = {
    Ps: P2(sender.P),
    Pr: P2(receiverP),
    Pa: P2(auditorP),
    BoldC: bold.map((c) => P2(c.C)),
    BoldD: bold.map((c) => P2(c.D)),
    BnewC: Bnew.map((c) => P2(c.C)),
    BnewD: Bnew.map((c) => P2(c.D.s)),
    TC: T.map((c) => P2(c.C)),
    TDs: T.map((c) => P2(c.D.s)),
    TDr: T.map((c) => P2(c.D.r)),
    TDa: T.map((c) => P2(c.D.a)),
    nonce: String(nonce),
    sender: String(senderName),
    receiver: String(receiverName),
    s: String(sender.s),
    vold: voldChunks.map(String),
    v: vC.map(String),
    vnew: nC.map(String),
    rT: rT.map(String),
    rN: rN.map(String),
  };
  return { input, T, Bnew: Bnew.map((c) => ({ C: c.C, D: c.D.s })), vNew };
}

/**
 * Withdraw = the transfer circuit with r_T = 0 and receiver = self: TC_k = v_k·G, all handles
 * are the identity. The contract recomputes TC from the public amount and checks it.
 */
export function buildWithdrawWitness({ owner, auditorP, bold, voldChunks, v, nonce, ownerName, close = false }) {
  const vOld = join64(voldChunks[0], voldChunks[1]);
  if (BigInt(v) > vOld) throw new Error("insufficient balance");
  const vNew = vOld - BigInt(v);
  const vC = split64(v);
  const nC = split64(vNew);
  // closing the box: the new balance is zero and encrypted with zero randomness, so the new
  // ciphertext is the identity everywhere and the contract can see the box is empty
  if (close && vNew !== 0n) throw new Error("close requires withdrawing the whole balance");
  const rN = close ? [0n, 0n] : [randScalar(), randScalar()];
  const T = [0, 1].map((k) => encrypt(vC[k], 0n, { s: owner.P, r: owner.P, a: auditorP }));
  const Bnew = [0, 1].map((k) => encrypt(nC[k], rN[k], { s: owner.P }));
  const P2 = (p) => toObj(p).map(String);
  const input = {
    Ps: P2(owner.P),
    Pr: P2(owner.P),
    Pa: P2(auditorP),
    BoldC: bold.map((c) => P2(c.C)),
    BoldD: bold.map((c) => P2(c.D)),
    BnewC: Bnew.map((c) => P2(c.C)),
    BnewD: Bnew.map((c) => P2(c.D.s)),
    TC: T.map((c) => P2(c.C)),
    TDs: T.map((c) => P2(c.D.s)),
    TDr: T.map((c) => P2(c.D.r)),
    TDa: T.map((c) => P2(c.D.a)),
    nonce: String(nonce),
    sender: String(ownerName),
    receiver: String(ownerName),
    s: String(owner.s),
    vold: voldChunks.map(String),
    v: vC.map(String),
    vnew: nC.map(String),
    rT: ["0", "0"],
    rN: rN.map(String),
  };
  return { input, Bnew: Bnew.map((c) => ({ C: c.C, D: c.D.s })), vNew };
}

// --- byte encodings shared with the contract (big-endian 32-byte words) ---
const w32 = (n) => BigInt(n).toString(16).padStart(64, "0");
export const ptHex = (p) => { const o = toObj(p); return w32(o[0]) + w32(o[1]); };
export const ptFromHex = (h, off = 0) => toPt([BigInt("0x" + h.slice(off, off + 64)), BigInt("0x" + h.slice(off + 64, off + 128))]);
/** 256-B pair set: lo.C lo.D hi.C hi.D */
export const ctHex = (ct) => ptHex(ct[0].C) + ptHex(ct[0].D) + ptHex(ct[1].C) + ptHex(ct[1].D);
export const ctFromHex = (h) => [{ C: ptFromHex(h, 0), D: ptFromHex(h, 128) }, { C: ptFromHex(h, 256), D: ptFromHex(h, 384) }];
/** 512-B transfer set: per chunk C Ds Dr Da */
export const tHex = (T) => T.map((c) => ptHex(c.C) + ptHex(c.D.s) + ptHex(c.D.r) + ptHex(c.D.a)).join("");
/** receiver-side view of a transfer's `t` hex: [{C, D: Dr}] per chunk */
export const tReceiverFromHex = (h) => [0, 1].map((k) => ({ C: ptFromHex(h, k * 512), D: ptFromHex(h, k * 512 + 256) }));
export const tAuditorFromHex = (h) => [0, 1].map((k) => ({ C: ptFromHex(h, k * 512), D: ptFromHex(h, k * 512 + 384) }));

/** 32-byte compressed point hex: y big-endian with bit 255 = (x > (p-1)/2). */
export function compressHex(p) {
  const [x, y] = toObj(p);
  const half = (F.p - 1n) / 2n;
  const v = x > half ? y | (1n << 255n) : y;
  return v.toString(16).padStart(64, "0");
}
export function decompressHex(h) {
  h = h.replace(/^0x/, "");
  if (h.length === 128) return ptFromHex(h);
  const v = BigInt("0x" + h);
  const sign = (v >> 255n) & 1n;
  const y = F.e(v & ((1n << 255n) - 1n));
  const y2 = F.square(y);
  const num = F.sub(F.one, y2);
  const den = F.sub(bj.A, F.mul(bj.D, y2)); // x^2 = (1 - y^2) / (a - d y^2)
  let x = F.sqrt(F.div(num, den));
  if (x === null || x === undefined) throw new Error("not a point");
  const xo = F.toObject(x);
  const xIsHigh = xo > (F.p - 1n) / 2n ? 1n : 0n;
  if (xIsHigh !== sign) x = F.neg(x);
  return [x, y];
}

const api = {
  init, keygen, encrypt, encryptPublic, decryptPoint, decrypt64, bsgs32, buildBabyTable, ctAdd, mul, add,
  split64, join64, randScalar, toObj, toPt, buildTransferWitness, buildWithdrawWitness,
  ptHex, ptFromHex, ctHex, ctFromHex, tHex, tReceiverFromHex, tAuditorFromHex, compressHex, decompressHex,
  get F() { return F; }, get G() { return G; }, get H() { return H; }, get INF() { return INF; }, get bj() { return bj; },
};
export default api;
