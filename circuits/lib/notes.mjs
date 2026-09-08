// Shielded note library (docs/06 §2): keys, notes, commitments, nullifiers, the Merkle tree,
// the two encryptions, and the join-split witness. Mirrors shielded/joinsplit.circom exactly.
import { buildBabyjub, buildPoseidon } from "circomlibjs";
import { randomBytes } from "node:crypto";

export const DEPTH = 20;
export const TOKENS = { XPR: 1n, XMD: 2n };

let bj, F, poseidon, B8, L;

export async function init() {
  if (bj) return api;
  bj = await buildBabyjub();
  F = bj.F;
  poseidon = await buildPoseidon();
  B8 = bj.Base8;
  L = bj.subOrder;
  return api;
}

const obj = (x) => F.toObject(x);
const H = (...xs) => obj(poseidon(xs.map((x) => F.e(x))));
const pt = (p) => [obj(p[0]), obj(p[1])];

export function randField() {
  return BigInt("0x" + randomBytes(31).toString("hex")); // < 2^248 < r
}
export function randScalar() {
  return BigInt("0x" + randomBytes(32).toString("hex")) % L;
}

/** keys from a spending scalar (any 253-bit value below the subgroup order) */
export function keygen(ask = randScalar()) {
  ask = BigInt(ask) % L;
  const pk = pt(bj.mulPointEscalar(B8, ask));
  const nk = H(ask, 0n);
  return { ask, pk, nk };
}

export const commitment = (n) => H(n.pk[0], n.pk[1], n.v, n.token, n.r);
export const nullifier = (nk, index) => H(nk, BigInt(index));
/** the nullifier a disabled second input emits: Poseidon(nk, 2^40 + dummy), dummy < 2^40 */
export const dummyNullifier = (nk, dummy) => H(nk, (1n << 40n) + BigInt(dummy));

/** a fresh note to `pk` */
export function newNote(pk, v, token, r = randField()) {
  const n = { pk, v: BigInt(v), token: BigInt(token), r };
  n.cm = commitment(n);
  return n;
}

// ---- point compression: (y, parity of x). As a 32-byte word: y with the parity in bit 255. ----
const CURVE_A = 168700n, CURVE_D = 168696n;
export const compressPoint = (p) => BigInt(p[1]) | ((BigInt(p[0]) & 1n) << 255n);
/** x from y and the parity of x: x² = (1 − y²) / (a − d·y²) */
export function xFromY(y, parity) {
  const Y = F.e(y);
  const y2 = F.mul(Y, Y);
  const num = F.sub(F.one, y2);
  const den = F.sub(F.e(CURVE_A), F.mul(F.e(CURVE_D), y2));
  const x2 = F.mul(num, F.inv(den));
  // Euler's criterion first: ffjavascript's sqrt loops on a non-residue
  if (!F.isZero(x2) && !F.eq(F.exp(x2, (F.p - 1n) / 2n), F.one)) throw new Error("not a curve point");
  const root = F.sqrt(x2);
  let x = F.toObject(root);
  if ((x & 1n) !== BigInt(parity)) x = F.p - x;
  return x;
}
export function decompressPoint(w) {
  const parity = (BigInt(w) >> 255n) & 1n;
  const y = BigInt(w) & ((1n << 255n) - 1n);
  return [xFromY(y, parity), y];
}

// ---- Merkle tree of commitments, depth DEPTH, Poseidon(2) nodes, zero chain leaves ----
export class Tree {
  constructor(depth = DEPTH) {
    this.depth = depth;
    this.zeros = [0n];
    for (let i = 0; i < depth; i++) this.zeros.push(H(this.zeros[i], this.zeros[i]));
    this.levels = Array.from({ length: depth + 1 }, () => []);
  }
  get size() { return this.levels[0].length; }
  node(level, i) { return i < this.levels[level].length ? this.levels[level][i] : this.zeros[level]; }
  append(cm) {
    const index = this.levels[0].length;
    this.levels[0].push(BigInt(cm));
    let i = index;
    for (let l = 0; l < this.depth; l++) {
      const pi = i >> 1;
      const left = this.node(l, pi * 2), right = this.node(l, pi * 2 + 1);
      this.levels[l + 1][pi] = H(left, right);
      i = pi;
    }
    return index;
  }
  get root() { return this.node(this.depth, 0); }
  path(index) {
    const siblings = [], bits = [];
    let i = index;
    for (let l = 0; l < this.depth; l++) {
      bits.push(i & 1);
      siblings.push(this.node(l, i ^ 1));
      i >>= 1;
    }
    return { siblings, bits };
  }
}

// ---- encryption: k = Poseidon(shared.x, shared.y); c[m] = plain[m] + Poseidon(k, m) ----
function padKey(shared) { return H(shared[0], shared[1]); }
function encryptWith(shared, plain) {
  const k = padKey(shared);
  return plain.map((p, m) => F.toObject(F.add(F.e(p), F.e(H(k, BigInt(m))))));
}
function decryptWith(shared, c) {
  const k = padKey(shared);
  return c.map((x, m) => F.toObject(F.sub(F.e(x), F.e(H(k, BigInt(m))))));
}
const ecdh = (scalar, point) => pt(bj.mulPointEscalar([F.e(point[0]), F.e(point[1])], BigInt(scalar)));

/** one field element sealed to a public key with the note scheme (the dapp's `sealTo`): fresh ephemeral key, then plain + Poseidon mask */
export function sealTo(pk, plain) {
  const esk = randScalar();
  return { epk: pt(bj.mulPointEscalar(B8, esk)), c: encryptWith(ecdh(esk, pk), [BigInt(plain)])[0] };
}
/** the committee side of a sealed scalar: epk as a point, c one word */
export const openSealed = (ask, epk, c) => decryptWith(ecdh(ask, epk), [c])[0];

const TWO64 = 1n << 64n, TWO72 = 1n << 72n;
/** v (64 bits) + token·2^64 (8 bits) + parity·2^72 */
export const pack = (v, token, parity = 0n) => BigInt(v) + BigInt(token) * TWO64 + BigInt(parity) * TWO72;
export const unpack = (w) => [w % TWO64, (w / TWO64) % 256n, (w / TWO72) & 1n];

/** receiver side: recover a note from (epk, cr) with own key; null if it is not ours */
export function tryDecryptReceiver(keys, epk, cr, cmOnChain) {
  const [packed, r] = decryptWith(ecdh(keys.ask, epk), cr);
  const [v, token] = unpack(packed);
  const n = { pk: keys.pk, v, token, r };
  n.cm = commitment(n);
  return n.cm === BigInt(cmOnChain) ? n : null;
}

/** auditor side: recover receiver key and note from (epk, ca); the sender is named by the action */
export function decryptAuditor(auditorAsk, epk, ca, cmOnChain) {
  const [pky, packed, r] = decryptWith(ecdh(auditorAsk, epk), ca);
  const [v, token, parity] = unpack(packed);
  let pkx = 0n, valid = false;
  try { pkx = xFromY(pky, parity); } catch { /* not a point: leave invalid */ }
  const n = { pk: [pkx, pky], v, token, r };
  n.cm = commitment(n);
  valid = n.cm === BigInt(cmOnChain);
  n.valid = valid;
  return n;
}

/**
 * Build the join-split witness. `inputs`: 1 or 2 of {note, index}; `outputs`: exactly 2 of
 * {pk, v, rho?, r?}; `tree`: the Tree the inputs sit in; `vPub`, `tokenPub`, `to` for withdrawals.
 * Returns { input (circuit signals), expected (public signals we can recompute), outNotes }.
 */
export function buildJoinSplit({ keys, inputs, outputs, tree, auditorPk, sender, vPub = 0n, tokenPub = 0n, to = 0n }) {
  if (sender === undefined) throw new Error("sender (account name as u64) is required");
  if (inputs.length < 1 || inputs.length > 2) throw new Error("1 or 2 inputs");
  if (outputs.length !== 2) throw new Error("exactly 2 outputs");
  const token = inputs[0].note.token;
  const ins = [inputs[0], inputs[1] ?? null];
  const inV = ins.map((i) => (i ? i.note.v : 0n));
  const inToken = ins.map((i) => (i ? i.note.token : token));
  const inR = ins.map((i) => (i ? i.note.r : 0n));
  const inIndex = ins.map((i) => (i ? BigInt(i.index) : 0n));
  const inSiblings = ins.map((i) => (i ? tree.path(i.index).siblings : Array(tree.depth).fill(0n)));
  const enabled1 = ins[1] ? 1n : 0n;
  // revision 5: a disabled second input carries a fresh dummy nullifier in a reserved domain
  const dummy = BigInt("0x" + randomBytes(5).toString("hex"));
  const outNotes = outputs.map((o) => newNote(o.pk, o.v, token, o.r));
  const esk = outputs.map((o) => o.esk ?? randScalar());
  const total = inV[0] + inV[1];
  if (total !== outNotes[0].v + outNotes[1].v + BigInt(vPub)) throw new Error("values do not balance");
  for (const n of outNotes) if (n.v < 0n || n.v >= 1n << 64n) throw new Error("output out of range");

  const input = {
    ask: keys.ask,
    inV, inToken, inR, inIndex, inSiblings, enabled1, dummy,
    outPk: outNotes.map((n) => n.pk),
    outV: outNotes.map((n) => n.v),
    outR: outNotes.map((n) => n.r),
    esk,
    root: tree.root,
    vPub: BigInt(vPub),
    tokenPub: BigInt(tokenPub),
    to: BigInt(to),
    sender: BigInt(sender),
    A: auditorPk,
  };

  const expected = {
    nf: ins.map((i) => (i ? nullifier(keys.nk, i.index) : dummyNullifier(keys.nk, dummy))),
    cm: outNotes.map((n) => n.cm),
    epk: esk.map((e) => pt(bj.mulPointEscalar(B8, e))),
    cr: outNotes.map((n, j) => encryptWith(ecdh(esk[j], n.pk), [pack(n.v, n.token), n.r])),
    ca: outNotes.map((n, j) => encryptWith(ecdh(esk[j], auditorPk), [n.pk[1], pack(n.v, n.token, n.pk[0] & 1n), n.r])),
    senderPk: keys.pk,
  };
  return { input, expected, outNotes };
}

/** public signals in the circuit's order: nf[2] cm[2] epk[2][2] cr[2][2] ca[2][3] senderPk[2] root vPub tokenPub to sender A[2] */
export function publicSignals(expected, { root, vPub = 0n, tokenPub = 0n, to = 0n, sender, A }) {
  return [
    ...expected.nf, ...expected.cm, ...expected.epk.flat(), ...expected.cr.flat(), ...expected.ca.flat(), ...expected.senderPk,
    root, BigInt(vPub), BigInt(tokenPub), BigInt(to), BigInt(sender), ...A,
  ].map((x) => BigInt(x));
}

/**
 * What the sender puts in the action's `publics` (16 words): nf[2] cm[2] epk compressed[2]
 * cr[2][2] ca[2][3]. The amount, token id and root sequence travel as native fields; the
 * contract supplies senderPk, sender, A, decompresses epk and looks the root up by sequence.
 */
export function actionPublics(expected) {
  return [
    ...expected.nf, ...expected.cm, ...expected.epk.map(compressPoint), ...expected.cr.flat(), ...expected.ca.flat(),
  ].map((x) => BigInt(x));
}

/** account name → u64 as the chain does (base-32 name encoding) */
export function nameToU64(name) {
  const chars = ".12345abcdefghijklmnopqrstuvwxyz";
  let n = 0n;
  for (let i = 0; i < 12; i++) {
    const c = i < name.length ? BigInt(chars.indexOf(name[i])) : 0n;
    n |= c << BigInt(64 - 5 * (i + 1));
  }
  if (name.length > 12) n |= BigInt(chars.indexOf(name[12])) & 0xfn;
  return n;
}

export const hex32 = (x) => BigInt(x).toString(16).padStart(64, "0");

const api = {
  init, keygen, newNote, commitment, nullifier, Tree, buildJoinSplit, publicSignals, actionPublics, pack, unpack,
  compressPoint, decompressPoint, xFromY, tryDecryptReceiver, decryptAuditor, sealTo, openSealed, dummyNullifier, randField, randScalar, nameToU64, hex32, TOKENS, DEPTH,
  get F() { return F; }, get bj() { return bj; }, get B8() { return B8; },
};
export default api;
