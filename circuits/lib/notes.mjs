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

export const commitment = (n) => H(n.pk[0], n.pk[1], n.v, n.token, n.rho, n.r);
export const nullifier = (nk, index) => H(nk, BigInt(index));

/** a fresh note to `pk` */
export function newNote(pk, v, token, rho = randField(), r = randField()) {
  const n = { pk, v: BigInt(v), token: BigInt(token), rho, r };
  n.cm = commitment(n);
  return n;
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

/** receiver side: recover a note from (epk, cr) with own key; null if it is not ours */
export function tryDecryptReceiver(keys, epk, cr, cmOnChain) {
  const [v, token, rho, r] = decryptWith(ecdh(keys.ask, epk), cr);
  const n = { pk: keys.pk, v, token, rho, r };
  n.cm = commitment(n);
  return n.cm === BigInt(cmOnChain) ? n : null;
}

/** auditor side: recover receiver key, note and sender key from (epk, ca) */
export function decryptAuditor(auditorAsk, epk, ca, cmOnChain) {
  const [pkx, pky, v, token, rho, r, sx, sy] = decryptWith(ecdh(auditorAsk, epk), ca);
  const n = { pk: [pkx, pky], v, token, rho, r, sender: [sx, sy] };
  n.cm = commitment(n);
  n.valid = n.cm === BigInt(cmOnChain);
  return n;
}

/**
 * Build the join-split witness. `inputs`: 1 or 2 of {note, index}; `outputs`: exactly 2 of
 * {pk, v, rho?, r?}; `tree`: the Tree the inputs sit in; `vPub`, `tokenPub`, `to` for withdrawals.
 * Returns { input (circuit signals), expected (public signals we can recompute), outNotes }.
 */
export function buildJoinSplit({ keys, inputs, outputs, tree, auditorPk, vPub = 0n, tokenPub = 0n, to = 0n }) {
  if (inputs.length < 1 || inputs.length > 2) throw new Error("1 or 2 inputs");
  if (outputs.length !== 2) throw new Error("exactly 2 outputs");
  const token = inputs[0].note.token;
  const ins = [inputs[0], inputs[1] ?? null];
  const inV = ins.map((i) => (i ? i.note.v : 0n));
  const inToken = ins.map((i) => (i ? i.note.token : token));
  const inRho = ins.map((i) => (i ? i.note.rho : 0n));
  const inR = ins.map((i) => (i ? i.note.r : 0n));
  const inIndex = ins.map((i) => (i ? BigInt(i.index) : 0n));
  const inSiblings = ins.map((i) => (i ? tree.path(i.index).siblings : Array(tree.depth).fill(0n)));
  const enabled1 = ins[1] ? 1n : 0n;
  const outNotes = outputs.map((o) => newNote(o.pk, o.v, token, o.rho, o.r));
  const esk = outputs.map((o) => o.esk ?? randScalar());
  const total = inV[0] + inV[1];
  if (total !== outNotes[0].v + outNotes[1].v + BigInt(vPub)) throw new Error("values do not balance");
  for (const n of outNotes) if (n.v < 0n || n.v >= 1n << 64n) throw new Error("output out of range");

  const input = {
    ask: keys.ask,
    inV, inToken, inRho, inR, inIndex, inSiblings, enabled1,
    outPk: outNotes.map((n) => n.pk),
    outV: outNotes.map((n) => n.v),
    outRho: outNotes.map((n) => n.rho),
    outR: outNotes.map((n) => n.r),
    esk,
    root: tree.root,
    vPub: BigInt(vPub),
    tokenPub: BigInt(tokenPub),
    to: BigInt(to),
    A: auditorPk,
  };

  const expected = {
    nf: ins.map((i) => (i ? nullifier(keys.nk, i.index) : 0n)),
    cm: outNotes.map((n) => n.cm),
    epk: esk.map((e) => pt(bj.mulPointEscalar(B8, e))),
    cr: outNotes.map((n, j) => encryptWith(ecdh(esk[j], n.pk), [n.v, n.token, n.rho, n.r])),
    ca: outNotes.map((n, j) => encryptWith(ecdh(esk[j], auditorPk), [n.pk[0], n.pk[1], n.v, n.token, n.rho, n.r, keys.pk[0], keys.pk[1]])),
  };
  return { input, expected, outNotes };
}

/** public signals in the circuit's order: nf[2] cm[2] epk[2][2] cr[2][4] ca[2][8] root vPub tokenPub to A[2] */
export function publicSignals(expected, { root, vPub = 0n, tokenPub = 0n, to = 0n, A }) {
  return [
    ...expected.nf, ...expected.cm, ...expected.epk.flat(), ...expected.cr.flat(), ...expected.ca.flat(),
    root, BigInt(vPub), BigInt(tokenPub), BigInt(to), ...A,
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
  init, keygen, newNote, commitment, nullifier, Tree, buildJoinSplit, publicSignals,
  tryDecryptReceiver, decryptAuditor, randField, randScalar, nameToU64, hex32, TOKENS, DEPTH,
  get F() { return F; }, get bj() { return bj; }, get B8() { return B8; },
};
export default api;
