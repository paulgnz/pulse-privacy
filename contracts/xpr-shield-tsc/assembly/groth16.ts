import {
  check,
  U256,
  AltBn128G1,
  AltBn128G2,
  AltBn128Pair,
  bn128Add,
  bn128Mul,
  bn128Pair,
} from "proton-tsc";

// T1 — Groth16 verifier on bn254 via Leap's CRYPTO_PRIMITIVES (alt_bn128_add/mul/pair),
// as wrapped by proton-tsc. Encoding is EIP-196/197: big-endian 32-byte words, G1 = (x, y),
// G2 = (x_im, x_re, y_im, y_re). Verifying equation:
//   e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) == 1
//   vk_x = IC[0] + Σ input_i · IC[i+1]
//
// Layouts (bytes):
//   vk     = alpha(64) ‖ beta(128) ‖ gamma(128) ‖ delta(128) ‖ IC[0..n](64 each)
//   proof  = A(64) ‖ B(128) ‖ C(64)
//   inputs = 32 * n
//
// This action exists to prove the pipeline end to end (arkworks proof → testnet). The real
// confidential-token contract stores the vk in a table and calls the same `groth16Verify`.

// bn254 base-field modulus p (big-endian), for negating a G1 point: -P = (x, p - y).
const P_BE: u8[] = [
  0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
  0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

function readG1(a: u8[], off: i32): AltBn128G1 {
  const g = new AltBn128G1();
  g.unpack(a.slice(off, off + 64));
  return g;
}

function readG2(a: u8[], off: i32): AltBn128G2 {
  const g = new AltBn128G2();
  g.unpack(a.slice(off, off + 128));
  return g;
}

function negG1(g: AltBn128G1): AltBn128G1 {
  if (g.y.isZero()) return g; // point at infinity
  const p = U256.fromBytesBE(P_BE);
  return new AltBn128G1(g.x, p - g.y);
}

/** Returns true iff the proof verifies. Reusable by the token contract. */
export function groth16Verify(vk: u8[], proof: u8[], inputs: u8[]): bool {
  check(proof.length == 256, "proof must be 256 bytes");
  check(inputs.length % 32 == 0, "inputs must be 32-byte words");
  const n = inputs.length / 32;
  check(vk.length == 64 + 3 * 128 + 64 * (n + 1), "vk length does not match input count");

  const alpha = readG1(vk, 0);
  const beta = readG2(vk, 64);
  const gamma = readG2(vk, 192);
  const delta = readG2(vk, 320);

  // vk_x = IC[0] + Σ input_i · IC[i+1]
  let vkx = readG1(vk, 448);
  for (let i = 0; i < n; i++) {
    const s = U256.fromBytesBE(inputs.slice(i * 32, i * 32 + 32));
    const ic = readG1(vk, 448 + 64 * (i + 1));
    vkx = bn128Add(vkx, bn128Mul(ic, s));
  }

  const a = readG1(proof, 0);
  const b = readG2(proof, 64);
  const c = readG1(proof, 192);

  const pairs: AltBn128Pair[] = [
    new AltBn128Pair(negG1(a), b),
    new AltBn128Pair(alpha, beta),
    new AltBn128Pair(vkx, gamma),
    new AltBn128Pair(c, delta),
  ];
  return bn128Pair(pairs);
}
