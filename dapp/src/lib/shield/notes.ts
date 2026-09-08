// Shielded notes for the browser: keys, commitments, nullifiers, the Merkle tree, both
// encryptions and the join-split witness. Mirrors circuits/lib/notes.mjs and
// circuits/shielded/joinsplit.circom exactly.
import { A as CURVE_A, D as CURVE_D, G, L, finv, fmul, fsqrt, fsub, mul, randScalar as randL } from "../crypto/babyjub";
import type { Pt } from "../crypto/babyjub";
import { P } from "../crypto/babyjub";
import { hash2, poseidon } from "./poseidon";

export const DEPTH = 20;
export const TOKEN_IDS: Record<string, bigint> = { XPR: 1n, XMD: 2n };

export interface ShieldKeys { ask: bigint; pk: Pt; nk: bigint }
export interface Note { pk: Pt; v: bigint; token: bigint; r: bigint; cm: bigint }
export interface OwnedNote extends Note { index: number; kind?: "deposit" | "note" }

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
export const commitment = (n: { pk: Pt; v: bigint; token: bigint; r: bigint }) => poseidon([n.pk[0], n.pk[1], n.v, n.token, n.r]);
export const nullifier = (nk: bigint, index: number) => hash2(nk, BigInt(index));
export function newNote(pk: Pt, v: bigint, token: bigint, r = randField()): Note {
  const n = { pk, v, token, r, cm: 0n };
  n.cm = commitment(n);
  return n;
}

// ---- point compression: (y, parity of x); as a word, y with the parity in bit 255 ----
export const compressPoint = (p: Pt) => p[1] | ((p[0] & 1n) << 255n);
/** x from y and the parity of x: x² = (1 − y²) / (a − d·y²) */
export function xFromY(y: bigint, parity: bigint): bigint {
  const y2 = fmul(y, y);
  const x2 = fmul(fsub(1n, y2), finv(fsub(CURVE_A, fmul(CURVE_D, y2))));
  const root = fsqrt(x2);
  if (root === null) throw new Error("not a curve point");
  if (root === 0n) return 0n;
  return (root & 1n) === parity ? root : P - root;
}
export function decompressPoint(w: bigint): Pt {
  const parity = (w >> 255n) & 1n;
  const y = w & ((1n << 255n) - 1n);
  return [xFromY(y, parity), y];
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

/** one field element sealed to a public key with the note scheme: a fresh ephemeral key, then plain + Poseidon mask */
export function sealTo(pk: Pt, plain: bigint): { epk: Pt; c: bigint } {
  const esk = randScalar();
  return { epk: mul(G, esk), c: encryptWith(ecdh(esk, pk), [plain])[0] };
}
export const openSealed = (ask: bigint, epk: Pt, c: bigint): bigint => decryptWith(ecdh(ask, epk), [c])[0];

const TWO64 = 1n << 64n, TWO72 = 1n << 72n;
export const pack = (v: bigint, token: bigint, parity = 0n) => v + token * TWO64 + parity * TWO72;
export const unpack = (w: bigint): [bigint, bigint, bigint] => [w % TWO64, (w / TWO64) % 256n, (w / TWO72) & 1n];

/** our note behind (epk, cr) with commitment cm, or null */
export function tryDecryptReceiver(keys: ShieldKeys, epk: Pt, cr: bigint[], cm: bigint): Note | null {
  const [packed, r] = decryptWith(ecdh(keys.ask, epk), cr);
  const [v, token] = unpack(packed);
  const n = { pk: keys.pk, v, token, r, cm: 0n };
  n.cm = commitment(n);
  return n.cm === cm ? n : null;
}

/** auditor side: receiver key and note from (epk, ca); the sender is named by the signed action */
export function decryptAuditor(auditorAsk: bigint, epk: Pt, ca: bigint[], cm: bigint): (Note & { valid: boolean }) | null {
  const [pky, packed, r] = decryptWith(ecdh(auditorAsk, epk), ca);
  const [v, token, parity] = unpack(packed);
  let pkx: bigint;
  try { pkx = xFromY(pky, parity); } catch { return null; }
  const n = { pk: [pkx, pky] as Pt, v, token, r, cm: 0n, valid: false };
  n.cm = commitment(n);
  n.valid = n.cm === cm;
  return n;
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
  /** the 16 words the action carries: nf cm epk(compressed) cr ca */
  actionPublics: bigint[];
  /** the verifier's 27 words, for checking a proof locally */
  publicSignals: bigint[];
  vPub: bigint;
  tokenPub: bigint;
}

export function buildJoinSplit({ keys, inputs, outputs, tree, auditorPk, sender, vPub = 0n, tokenPub = 0n, to = 0n }: JoinSplitInput): JoinSplitBuilt {
  if (inputs.length < 1 || inputs.length > 2) throw new Error("1 or 2 inputs");
  if (outputs.length !== 2) throw new Error("exactly 2 outputs");
  const token = inputs[0].token;
  const ins: (OwnedNote | null)[] = [inputs[0], inputs[1] ?? null];
  // the two outputs go on chain in random order, so position does not say which is the change
  const flip = crypto.getRandomValues(new Uint8Array(1))[0] & 1;
  const ordered = flip ? [outputs[1], outputs[0]] : outputs;
  const outNotes = ordered.map((o) => newNote(o.pk, o.v, token));
  const esk = outputs.map(() => randScalar());
  const total = ins.reduce((s, i) => s + (i ? i.v : 0n), 0n);
  if (total !== outNotes[0].v + outNotes[1].v + vPub) throw new Error("values do not balance");
  for (const n of outNotes) if (n.v < 0n || n.v >= 1n << 64n) throw new Error("output out of range");
  const S = (x: bigint | number) => x.toString();
  const input = {
    ask: S(keys.ask),
    inV: ins.map((i) => S(i ? i.v : 0n)),
    inToken: ins.map((i) => S(i ? i.token : token)),
    inR: ins.map((i) => S(i ? i.r : 0n)),
    inIndex: ins.map((i) => S(i ? i.index : 0)),
    inSiblings: ins.map((i) => (i ? tree.path(i.index) : Array(tree.depth).fill(0n)).map(S)),
    enabled1: ins[1] ? "1" : "0",
    outPk: outNotes.map((n) => [S(n.pk[0]), S(n.pk[1])]),
    outV: outNotes.map((n) => S(n.v)),
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
  const cr = outNotes.map((n, j) => encryptWith(ecdh(esk[j], n.pk), [pack(n.v, n.token), n.r]));
  const ca = outNotes.map((n, j) => encryptWith(ecdh(esk[j], auditorPk), [n.pk[1], pack(n.v, n.token, n.pk[0] & 1n), n.r]));
  const cms = outNotes.map((n) => n.cm);
  const actionPublics = [...nf, ...cms, ...epk.map(compressPoint), ...cr.flat(), ...ca.flat()];
  const publicSignals = [...nf, ...cms, ...epk.flat(), ...cr.flat(), ...ca.flat(), keys.pk[0], keys.pk[1], tree.root, vPub, tokenPub, to, sender, auditorPk[0], auditorPk[1]];
  return { input, outNotes, nf, actionPublics, publicSignals, vPub, tokenPub };
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
