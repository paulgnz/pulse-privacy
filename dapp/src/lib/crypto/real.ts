// REAL crypto backend: twisted ElGamal on Baby Jubjub + Groth16 (snarkjs) with the circuit in
// /circuit/. Formats match circuits/lib/elgamal.mjs and the xprconf contract exactly
// (scripts/crosscheck.mjs proves it). Hex values are 0x-prefixed here; chain.ts strips them.
import * as snarkjs from "snarkjs";
import { G, H, INF, L, add, bsgs, buildBabyTable, finv, mul, neg, ptFromHex, ptHex, randScalar, type Pt } from "./babyjub";
import type {
  ChunkedCiphertext,
  Ciphertext,
  CryptoBackend,
  EncryptionKeypair,
  Hex,
  ProgressFn,
  TransferCiphertext,
  TransferProofInput,
  TransferProofOutput,
  WithdrawProofInput,
  WithdrawProofOutput,
} from "./types";

let WASM: string | Uint8Array = "/circuit/transfer.wasm";
let ZKEY: string | Uint8Array = "/circuit/transfer_final.zkey";
/** override artifact locations (tests in Node use the circuits/build files) */
export function setArtifacts(wasm: string | Uint8Array, zkey: string | Uint8Array) {
  WASM = wasm;
  ZKEY = zkey;
}
const TWO32 = 1n << 32n;

const hx = (bare: string): Hex => `0x${bare.toLowerCase()}` as Hex;
const bare = (h: string) => h.replace(/^0x/i, "").toLowerCase();
export const pt = (h: string): Pt => ptFromHex(bare(h));
export const ph = (p: Pt): Hex => hx(ptHex(p));

export const split64 = (v: bigint): [bigint, bigint] => [v % TWO32, v / TWO32];
export const join64 = (lo: bigint, hi: bigint) => lo + TWO32 * hi;

// --- ElGamal primitives ---
export function pubkeyFromSecret(s: bigint): Pt {
  return mul(H, finv(s, L));
}
/** C = v·G + r·H ; D_X = r·P_X */
export function encryptChunk(v: bigint, r: bigint, pubs: Pt[]): { C: Pt; D: Pt[] } {
  const C = add(mul(G, v), mul(H, r));
  return { C, D: pubs.map((p) => mul(p, r)) };
}
export const decryptPoint = (C: Pt, D: Pt, s: bigint): Pt => add(C, neg(mul(D, s)));
/** homomorphic add of two (C, D) chunk ciphertexts */
export const ctAdd = (a: Ciphertext, b: Ciphertext): Ciphertext => ({
  c: ph(add(pt(a.c), pt(b.c))),
  d: ph(add(pt(a.d), pt(b.d))),
});
export const chunkedAdd = (a: ChunkedCiphertext, b: ChunkedCiphertext): ChunkedCiphertext => ({ lo: ctAdd(a.lo, b.lo), hi: ctAdd(a.hi, b.hi) });

/** decrypt one chunk; tries 32 bits, then 36 (un-normalised chunks after folds), then 40 */
export function decryptChunk(ct: Ciphertext, s: bigint): bigint {
  const p = decryptPoint(pt(ct.c), pt(ct.d), s);
  for (const bits of [32, 36, 40]) {
    try {
      return bsgs(p, bits);
    } catch {
      /* try wider */
    }
  }
  throw new Error("cannot decrypt: not your key, or chunk out of range");
}

// --- Antelope name → u64 (field element for the circuit) ---
export function nameToU64(n: string): bigint {
  const cm = ".12345abcdefghijklmnopqrstuvwxyz";
  let v = 0n;
  for (let i = 0; i < 12; i++) {
    const c = i < n.length ? BigInt(cm.indexOf(n[i])) : 0n;
    v |= (c & 31n) << BigInt(64 - 5 * (i + 1));
  }
  if (n.length > 12) v |= BigInt(cm.indexOf(n[12])) & 15n;
  return v;
}

// --- snarkjs proof → contract encoding (EIP-196/197, G2 imaginary-first) ---
const w = (n: string | bigint) => BigInt(n).toString(16).padStart(64, "0");
type G1 = [string, string, string];
type G2 = [[string, string], [string, string], [string, string]];
const g1 = (p: G1) => w(p[0]) + w(p[1]);
const g2 = (p: G2) => w(p[0][1]) + w(p[0][0]) + w(p[1][1]) + w(p[1][0]);
export const encodeProof = (proof: { pi_a: G1; pi_b: G2; pi_c: G1 }): Hex => hx(g1(proof.pi_a) + g2(proof.pi_b) + g1(proof.pi_c));

/** decrypted chunks of a balance ciphertext (may be un-normalised) */
function oldChunks(ct: ChunkedCiphertext, s: bigint): [bigint, bigint] {
  return [decryptChunk(ct.lo, s), decryptChunk(ct.hi, s)];
}

const S = (x: bigint | string) => String(x);
const P2 = (p: Pt) => [S(p[0]), S(p[1])];

async function prove(input: Record<string, unknown>, onProgress?: ProgressFn) {
  onProgress?.(0.35, "proving (Groth16, in your browser)");
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  onProgress?.(0.95, `proof ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return { proof: encodeProof(proof as never), publicSignals: publicSignals as string[] };
}

export const realBackend: CryptoBackend = {
  name: "twisted ElGamal on Baby Jubjub + Groth16 (snarkjs)",
  isMock: false,

  async generateKeypair(): Promise<EncryptionKeypair> {
    const s = randScalar();
    return { secret: hx(w(s)), pubkey: ph(pubkeyFromSecret(s)) };
  },

  async pubkeyOf(secret: Hex): Promise<Hex> {
    const s = BigInt(secret) % L;
    if (s === 0n) throw new Error("invalid secret");
    return ph(pubkeyFromSecret(s));
  },

  async encryptAmount(amount: bigint, pubkey: Hex): Promise<ChunkedCiphertext> {
    const P = pt(pubkey);
    const [lo, hi] = split64(amount);
    const mk = (v: bigint): Ciphertext => {
      const e = encryptChunk(v, randScalar(), [P]);
      return { c: ph(e.C), d: ph(e.D[0]) };
    };
    return { lo: mk(lo), hi: mk(hi) };
  },

  async decryptAmount(ct: ChunkedCiphertext, secret: Hex): Promise<bigint> {
    const s = BigInt(secret) % L;
    buildBabyTable();
    const [lo, hi] = oldChunks(ct, s);
    return join64(lo, hi);
  },

  async proveTransfer(input: TransferProofInput, onProgress?: ProgressFn): Promise<TransferProofOutput> {
    const s = BigInt(input.senderKeypair.secret) % L;
    onProgress?.(0.05, "decrypting balance");
    buildBabyTable();
    const vold = oldChunks(input.oldBalanceCiphertext, s);
    const vOld = join64(vold[0], vold[1]);
    if (input.amount > vOld) throw new Error("insufficient confidential balance");
    const Ps = pubkeyFromSecret(s);
    const Pr = pt(input.receiverPubkey);
    const Pa = pt(input.auditorPubkey);
    onProgress?.(0.15, "encrypting to sender, receiver, auditor");
    const vC = split64(input.amount);
    const nC = split64(vOld - input.amount);
    const rT = [randScalar(), randScalar()];
    const rN = [randScalar(), randScalar()];
    const T = [0, 1].map((k) => encryptChunk(vC[k], rT[k], [Ps, Pr, Pa]));
    const B = [0, 1].map((k) => encryptChunk(nC[k], rN[k], [Ps]));
    const witness = {
      Ps: P2(Ps),
      Pr: P2(Pr),
      Pa: P2(Pa),
      BoldC: [pt(input.oldBalanceCiphertext.lo.c), pt(input.oldBalanceCiphertext.hi.c)].map(P2),
      BoldD: [pt(input.oldBalanceCiphertext.lo.d), pt(input.oldBalanceCiphertext.hi.d)].map(P2),
      BnewC: B.map((b) => P2(b.C)),
      BnewD: B.map((b) => P2(b.D[0])),
      TC: T.map((t) => P2(t.C)),
      TDs: T.map((t) => P2(t.D[0])),
      TDr: T.map((t) => P2(t.D[1])),
      TDa: T.map((t) => P2(t.D[2])),
      nonce: S(input.nonce),
      sender: S(nameToU64(input.sender)),
      receiver: S(nameToU64(input.receiver)),
      s: S(s),
      vold: vold.map(S),
      v: vC.map(S),
      vnew: nC.map(S),
      rT: rT.map(S),
      rN: rN.map(S),
    };
    const { proof } = await prove(witness, onProgress);
    const transfer: TransferCiphertext = {
      lo: { c: ph(T[0].C), dSender: ph(T[0].D[0]), dReceiver: ph(T[0].D[1]), dAuditor: ph(T[0].D[2]) },
      hi: { c: ph(T[1].C), dSender: ph(T[1].D[0]), dReceiver: ph(T[1].D[1]), dAuditor: ph(T[1].D[2]) },
    };
    const newBalance: ChunkedCiphertext = { lo: { c: ph(B[0].C), d: ph(B[0].D[0]) }, hi: { c: ph(B[1].C), d: ph(B[1].D[0]) } };
    onProgress?.(1, "done");
    return { transfer, newBalance, proof };
  },

  async proveWithdraw(input: WithdrawProofInput, onProgress?: ProgressFn): Promise<WithdrawProofOutput> {
    const s = BigInt(input.keypair.secret) % L;
    onProgress?.(0.05, "decrypting balance");
    buildBabyTable();
    const vold = oldChunks(input.oldBalanceCiphertext, s);
    const vOld = join64(vold[0], vold[1]);
    if (input.amount > vOld) throw new Error("insufficient confidential balance");
    const Ps = pubkeyFromSecret(s);
    const Pa = pt(input.auditorPubkey);
    const vC = split64(input.amount);
    const nC = split64(vOld - input.amount);
    if (input.close && input.amount !== vOld) throw new Error("closing the box means withdrawing the whole balance");
    // closing: the empty box is encrypted with zero randomness, so it is the identity everywhere and provably empty
    const rN = input.close ? [0n, 0n] : [randScalar(), randScalar()];
    // r_T = 0: TC_k = v_k·G, every handle = identity; the contract recomputes and checks
    const T = [0, 1].map((k) => encryptChunk(vC[k], 0n, [Ps, Ps, Pa]));
    const B = [0, 1].map((k) => encryptChunk(nC[k], rN[k], [Ps]));
    const me = S(nameToU64(input.owner));
    const witness = {
      Ps: P2(Ps),
      Pr: P2(Ps),
      Pa: P2(Pa),
      BoldC: [pt(input.oldBalanceCiphertext.lo.c), pt(input.oldBalanceCiphertext.hi.c)].map(P2),
      BoldD: [pt(input.oldBalanceCiphertext.lo.d), pt(input.oldBalanceCiphertext.hi.d)].map(P2),
      BnewC: B.map((b) => P2(b.C)),
      BnewD: B.map((b) => P2(b.D[0])),
      TC: T.map((t) => P2(t.C)),
      TDs: T.map((t) => P2(t.D[0])),
      TDr: T.map((t) => P2(t.D[1])),
      TDa: T.map((t) => P2(t.D[2])),
      nonce: S(input.nonce),
      sender: me,
      receiver: me,
      s: S(s),
      vold: vold.map(S),
      v: vC.map(S),
      vnew: nC.map(S),
      rT: ["0", "0"],
      rN: rN.map(S),
    };
    const { proof } = await prove(witness, onProgress);
    const newBalance: ChunkedCiphertext = { lo: { c: ph(B[0].C), d: ph(B[0].D[0]) }, hi: { c: ph(B[1].C), d: ph(B[1].D[0]) } };
    onProgress?.(1, "done");
    return { newBalance, proof };
  },
};

export const INF_HEX: Hex = ph(INF);
