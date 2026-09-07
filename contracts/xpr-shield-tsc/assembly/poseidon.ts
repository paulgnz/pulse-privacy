// Poseidon over the bn254 scalar field with circomlib's parameters, in the optimised form
// circomlibjs uses (`poseidon_opt.js`): dense MDS in the full rounds, a sparse matrix in each
// partial round. Bit-for-bit equal to circomlib's `Poseidon(n)` template and to circomlibjs.
// Supported widths: t = 3 (two inputs: Merkle nodes, nullifiers, keys) and t = 6 (five inputs:
// note commitments).
import { C3, C6, M3, M6, P3, P6, S3, S6, ZEROS } from "./poseidon_consts";
import { check } from "proton-tsc";
import { Limbs, add, addConst, copy, mulConst, pow5, zero } from "./fr";

const N_ROUNDS_F: i32 = 8;

function nRoundsP(t: i32): i32 {
  return t == 3 ? 57 : 60;
}

// state = M^T · state, i.e. new[i] = Σ_j M[j][i]·state[j], matrices stored row-major j then i.
// `acc` is caller-owned scratch of t elements, `tmp` one element.
function mixDense(state: StaticArray<Limbs>, M: u32[], t: i32, acc: StaticArray<Limbs>, tmp: Limbs): void {
  for (let i = 0; i < t; i++) {
    const a = unchecked(acc[i]);
    for (let k = 0; k < 8; k++) unchecked((a[k] = 0));
    for (let j = 0; j < t; j++) {
      mulConst(tmp, unchecked(state[j]), M, j * t + i);
      add(a, a, tmp);
    }
  }
  for (let i = 0; i < t; i++) copy(unchecked(state[i]), unchecked(acc[i]));
}

/** Poseidon of `inputs` (t − 1 field elements in Montgomery form); returns the first state word */
export function poseidon(inputs: StaticArray<Limbs>): Limbs {
  const t = inputs.length + 1;
  check(t == 3 || t == 6, "Poseidon width");
  const C = t == 3 ? C3 : C6;
  const S = t == 3 ? S3 : S6;
  const M = t == 3 ? M3 : M6;
  const P = t == 3 ? P3 : P6;
  const nP = nRoundsP(t);

  const state = new StaticArray<Limbs>(t);
  unchecked((state[0] = zero()));
  for (let i = 1; i < t; i++) {
    const s = zero();
    copy(s, unchecked(inputs[i - 1]));
    unchecked((state[i] = s));
  }
  for (let i = 0; i < t; i++) addConst(unchecked(state[i]), unchecked(state[i]), C, i);
  const acc = new StaticArray<Limbs>(t);
  for (let i = 0; i < t; i++) unchecked((acc[i] = zero()));
  const tmp = zero();
  const sc = zero();

  // first half of the full rounds
  for (let r = 0; r < N_ROUNDS_F / 2 - 1; r++) {
    for (let i = 0; i < t; i++) pow5(unchecked(state[i]), unchecked(state[i]), sc);
    for (let i = 0; i < t; i++) addConst(unchecked(state[i]), unchecked(state[i]), C, (r + 1) * t + i);
    mixDense(state, M, t, acc, tmp);
  }
  for (let i = 0; i < t; i++) pow5(unchecked(state[i]), unchecked(state[i]), sc);
  for (let i = 0; i < t; i++) addConst(unchecked(state[i]), unchecked(state[i]), C, (N_ROUNDS_F / 2) * t + i);
  mixDense(state, P, t, acc, tmp);

  // partial rounds: sbox on word 0, then the sparse mix
  const s0 = zero();
  const w = 2 * t - 1;
  for (let r = 0; r < nP; r++) {
    pow5(unchecked(state[0]), unchecked(state[0]), sc);
    addConst(unchecked(state[0]), unchecked(state[0]), C, (N_ROUNDS_F / 2 + 1) * t + r);
    // s0 = Σ_j S[w·r + j] · state[j]
    for (let i = 0; i < 8; i++) unchecked((s0[i] = 0));
    for (let j = 0; j < t; j++) {
      mulConst(tmp, unchecked(state[j]), S, w * r + j);
      add(s0, s0, tmp);
    }
    // state[k] += state[0] · S[w·r + t + k − 1]
    for (let k = 1; k < t; k++) {
      mulConst(tmp, unchecked(state[0]), S, w * r + t + k - 1);
      add(unchecked(state[k]), unchecked(state[k]), tmp);
    }
    copy(unchecked(state[0]), s0);
  }

  // second half of the full rounds
  for (let r = 0; r < N_ROUNDS_F / 2 - 1; r++) {
    for (let i = 0; i < t; i++) pow5(unchecked(state[i]), unchecked(state[i]), sc);
    for (let i = 0; i < t; i++) addConst(unchecked(state[i]), unchecked(state[i]), C, (N_ROUNDS_F / 2 + 1) * t + nP + r * t + i);
    mixDense(state, M, t, acc, tmp);
  }
  for (let i = 0; i < t; i++) pow5(unchecked(state[i]), unchecked(state[i]), sc);
  mixDense(state, M, t, acc, tmp);
  return unchecked(state[0]);
}

/** Poseidon(a, b): Merkle node, nullifier, key derivation */
export function hash2(a: Limbs, b: Limbs): Limbs {
  const inp = new StaticArray<Limbs>(2);
  unchecked((inp[0] = a));
  unchecked((inp[1] = b));
  return poseidon(inp);
}

/** the empty subtree hash at `level` (0 = empty leaf), from the precomputed zero chain */
export function zeroAt(level: i32): Limbs {
  const out = zero();
  const base = level << 3;
  for (let i = 0; i < 8; i++) unchecked((out[i] = ZEROS[base + i]));
  return out;
}
