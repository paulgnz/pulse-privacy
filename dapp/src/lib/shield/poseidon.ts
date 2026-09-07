// Poseidon over the bn254 scalar field with circomlib's parameters, in the optimised form used
// by circomlibjs (`poseidon_opt.js`) and by the xprshield contract. Plain BigInt: about 0.3 ms
// per two-input hash in a browser, which is fine for trees of thousands of notes.
import consts from "./poseidon-consts.json";
import { P } from "../crypto/babyjub";

type Consts = { C: string[]; S: string[]; M: string[][]; P: string[][] };
const RAW = consts as unknown as Record<string, Consts>;
const N_ROUNDS_F = 8;
const N_ROUNDS_P: Record<number, number> = { 3: 57, 6: 60 };

const cache = new Map<number, { C: bigint[]; S: bigint[]; M: bigint[][]; P: bigint[][] }>();
function params(t: number) {
  let p = cache.get(t);
  if (!p) {
    const r = RAW[String(t)];
    if (!r) throw new Error(`Poseidon width ${t} not available`);
    p = { C: r.C.map(BigInt), S: r.S.map(BigInt), M: r.M.map((row) => row.map(BigInt)), P: r.P.map((row) => row.map(BigInt)) };
    cache.set(t, p);
  }
  return p;
}

const mod = (a: bigint) => { const r = a % P; return r < 0n ? r + P : r; };
const pow5 = (a: bigint) => { const a2 = (a * a) % P; return (((a2 * a2) % P) * a) % P; };

/** Poseidon(inputs), inputs.length ∈ {2, 5}, all reduced mod P */
export function poseidon(inputs: bigint[]): bigint {
  const t = inputs.length + 1;
  const { C, S, M, P: PM } = params(t);
  const nP = N_ROUNDS_P[t];
  let state: bigint[] = [0n, ...inputs.map(mod)];
  state = state.map((a, i) => (a + C[i]) % P);
  const mix = (m: bigint[][]) => state.map((_, i) => state.reduce((acc, a, j) => (acc + m[j][i] * a) % P, 0n));
  for (let r = 0; r < N_ROUNDS_F / 2 - 1; r++) {
    state = state.map(pow5);
    state = state.map((a, i) => (a + C[(r + 1) * t + i]) % P);
    state = mix(M);
  }
  state = state.map(pow5);
  state = state.map((a, i) => (a + C[(N_ROUNDS_F / 2) * t + i]) % P);
  state = mix(PM);
  const w = 2 * t - 1;
  for (let r = 0; r < nP; r++) {
    state[0] = pow5(state[0]);
    state[0] = (state[0] + C[(N_ROUNDS_F / 2 + 1) * t + r]) % P;
    let s0 = 0n;
    for (let j = 0; j < t; j++) s0 = (s0 + S[w * r + j] * state[j]) % P;
    for (let k = 1; k < t; k++) state[k] = (state[k] + state[0] * S[w * r + t + k - 1]) % P;
    state[0] = s0;
  }
  for (let r = 0; r < N_ROUNDS_F / 2 - 1; r++) {
    state = state.map(pow5);
    state = state.map((a, i) => (a + C[(N_ROUNDS_F / 2 + 1) * t + nP + r * t + i]) % P);
    state = mix(M);
  }
  state = state.map(pow5);
  state = mix(M);
  return state[0];
}

export const hash2 = (a: bigint, b: bigint) => poseidon([a, b]);
