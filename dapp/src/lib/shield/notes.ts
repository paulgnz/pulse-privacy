// Shielded notes for the browser: keys, commitments, nullifiers, the Merkle tree, both
// encryptions and the join-split witness. Mirrors circuits/lib/notes.mjs and
// circuits/shielded/joinsplit.circom exactly.
import { G, L, mul, randScalar as randL } from "../crypto/babyjub";
import type { Pt } from "../crypto/babyjub";
import { P } from "../crypto/babyjub";
import { hash2, poseidon } from "./poseidon";

export const DEPTH = 20;
export const TOKEN_IDS: Record<string, bigint> = { XPR: 1n, XMD: 2n };

export interface ShieldKeys { ask: bigint; pk: Pt; nk: bigint }
export interface Note { pk: Pt; v: bigint; token: bigint; rho: bigint; r: bigint; cm: bigint }
export interface OwnedNote extends Note { index: number }

const randBig = (bytes: number) => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return x;
};
/** a random field element below 2^248 (so always below P) */
export const randField = () => randBig(31);
export const randScalar = () => randL();

export function keygen(ask: bigint): ShieldKeys {
  ask = ((ask % L) + L) % L;
  return { ask, pk: mul(G, ask), nk: hash2(ask, 0n) };
}
export const commitment = (n: { pk: Pt; v: bigint; token: bigint; rho: bigint; r: bigint }) => poseidon([n.pk[0], n.pk[1], n.v, n.token, n.rho, n.r]);
export const nullifier = (nk: bigint, index: number) => hash2(nk, BigInt(index));
export function newNote(pk: Pt, v: bigint, token: bigint, rho = randField(), r = randField()): Note {
  const n = { pk, v, token, rho, r, cm: 0n };
  n.cm = commitment(n);
  return n;
}

/** incremental Merkle tree of commitments; odd leaves of a deposit pair are 0 */
export class Tree {
  readonly zeros: bigint[] = [0n];
  readonly levels: bigint[][];
  constructor(readonly depth = DEPTH) {
    for (let i = 0; i < depth; i++) this.zeros.push(hash2(this.zeros[i], this.zeros[i]));
    this.levels = Array.from({ length: depth + 1 }, () => []);
  }
  get size() { return this.levels[0].length; }
  node(level: number, i: number) { return i < this.levels[level].length ? this.levels[level][i] : this.zeros[level]; }
  append(cm: bigint) {
    const index = this.levels[0].length;
    this.levels[0].push(cm);
    let i = index;
    for (let l = 0; l < this.depth; l++) {
      const pi = i >> 1;
      this.levels[l + 1][pi] = hash2(this.node(l, pi * 2), this.node(l, pi * 2 + 1));
      i = pi;
    }
    return index;
  }
  get root() { return this.node(this.depth, 0); }
  path(index: number) {
    const siblings: bigint[] = [];
    let i = index;
    for (let l = 0; l < this.depth; l++) { siblings.push(this.node(l, i ^ 1)); i >>= 1; }
    return siblings;
  }
}

// ---- encryption: k = Poseidon(shared.x, shared.y); c[m] = plain[m] + Poseidon(k, m) ----
const padKey = (shared: Pt) => hash2(shared[0], shared[1]);
const fmod = (a: bigint) => { const r = a % P; return r < 0n ? r + P : r; };
function encryptWith(shared: Pt, plain: bigint[]) { const k = padKey(shared); return plain.map((p, m) => fmod(p + hash2(k, BigInt(m)))); }
function decryptWith(shared: Pt, c: bigint[]) { const k = padKey(shared); return c.map((x, m) => fmod(x - hash2(k, BigInt(m)))); }
const ecdh = (scalar: bigint, point: Pt) => mul(point, scalar);

const TWO64 = 1n << 64n;
export const pack = (v: bigint, token: bigint) => v + token * TWO64;
export const unpack = (w: bigint): [bigint, bigint] => [w % TWO64, w / TWO64];

/** our note behind (epk, cr) with commitment cm, or null */
export function tryDecryptReceiver(keys: ShieldKeys, epk: Pt, cr: bigint[], cm: bigint): Note | null {
  const [packed, rho, r] = decryptWith(ecdh(keys.ask, epk), cr);
  const [v, token] = unpack(packed);
  const n = { pk: keys.pk, v, token, rho, r, cm: 0n };
  n.cm = commitment(n);
  return n.cm === cm ? n : null;
}

export interface JoinSplitInput {
  keys: ShieldKeys;
  inputs: OwnedNote[]; // 1 or 2
  outputs: { pk: Pt; v: bigint }[]; // exactly 2
  tree: Tree;
  auditorPk: Pt;
  /** the signing account's name as u64; the proof is bound to it */
  sender: bigint;
  vPub?: bigint;
  tokenPub?: bigint;
  to?: bigint;
}
export interface JoinSplitBuilt {
  input: Record<string, unknown>;
  outNotes: Note[];
  nf: bigint[];
  /** the 28 words the action carries: nf cm epk cr ca root vPub tokenPub to */
  actionPublics: bigint[];
  /** the verifier's 33 words, for checking a proof locally */
  publicSignals: bigint[];
}

export function buildJoinSplit({ keys, inputs, outputs, tree, auditorPk, sender, vPub = 0n, tokenPub = 0n, to = 0n }: JoinSplitInput): JoinSplitBuilt {
  if (inputs.length < 1 || inputs.length > 2) throw new Error("1 or 2 inputs");
  if (outputs.length !== 2) throw new Error("exactly 2 outputs");
  const token = inputs[0].token;
  const ins: (OwnedNote | null)[] = [inputs[0], inputs[1] ?? null];
  const outNotes = outputs.map((o) => newNote(o.pk, o.v, token));
  const esk = outputs.map(() => randScalar());
  const total = ins.reduce((s, i) => s + (i ? i.v : 0n), 0n);
  if (total !== outNotes[0].v + outNotes[1].v + vPub) throw new Error("values do not balance");
  for (const n of outNotes) if (n.v < 0n || n.v >= 1n << 64n) throw new Error("output out of range");
  const S = (x: bigint | number) => x.toString();
  const input = {
    ask: S(keys.ask),
    inV: ins.map((i) => S(i ? i.v : 0n)),
    inToken: ins.map((i) => S(i ? i.token : token)),
    inRho: ins.map((i) => S(i ? i.rho : 0n)),
    inR: ins.map((i) => S(i ? i.r : 0n)),
    inIndex: ins.map((i) => S(i ? i.index : 0)),
    inSiblings: ins.map((i) => (i ? tree.path(i.index) : Array(tree.depth).fill(0n)).map(S)),
    enabled1: ins[1] ? "1" : "0",
    outPk: outNotes.map((n) => [S(n.pk[0]), S(n.pk[1])]),
    outV: outNotes.map((n) => S(n.v)),
    outRho: outNotes.map((n) => S(n.rho)),
    outR: outNotes.map((n) => S(n.r)),
    esk: esk.map(S),
    root: S(tree.root),
    vPub: S(vPub),
    tokenPub: S(tokenPub),
    to: S(to),
    sender: S(sender),
    A: [S(auditorPk[0]), S(auditorPk[1])],
  };
  const nf = ins.map((i) => (i ? nullifier(keys.nk, i.index) : 0n));
  const epk = esk.map((e) => mul(G, e));
  const cr = outNotes.map((n, j) => encryptWith(ecdh(esk[j], n.pk), [pack(n.v, n.token), n.rho, n.r]));
  const ca = outNotes.map((n, j) => encryptWith(ecdh(esk[j], auditorPk), [n.pk[0], n.pk[1], pack(n.v, n.token), n.rho, n.r]));
  const head = [...nf, ...outNotes.map((n) => n.cm), ...epk.flat(), ...cr.flat(), ...ca.flat()];
  const actionPublics = [...head, tree.root, vPub, tokenPub, to];
  const publicSignals = [...head, keys.pk[0], keys.pk[1], tree.root, vPub, tokenPub, to, sender, auditorPk[0], auditorPk[1]];
  return { input, outNotes, nf, actionPublics, publicSignals };
}

/** account name → u64 (Antelope base-32 name encoding) */
export function nameToU64(name: string): bigint {
  const chars = ".12345abcdefghijklmnopqrstuvwxyz";
  let n = 0n;
  for (let i = 0; i < 12; i++) {
    const c = i < name.length ? BigInt(chars.indexOf(name[i])) : 0n;
    n |= (c & 31n) << BigInt(64 - 5 * (i + 1));
  }
  if (name.length > 12) n |= BigInt(chars.indexOf(name[12])) & 0xfn;
  return n;
}

export const hex32 = (x: bigint) => x.toString(16).padStart(64, "0");
export const words = (h: string): bigint[] => (h.match(/.{64}/g) ?? []).map((w) => BigInt("0x" + w));
