// snarkjs vk / proof / public signals → the byte layout expected by contracts/xpr-conf-tsc
// (EIP-196/197: big-endian 32-byte words, G1 = x‖y, G2 = x_im‖x_re‖y_im‖y_re).
// snarkjs stores Fp2 as [re, im], so G2 words are swapped here.

const w = (n) => BigInt(n).toString(16).padStart(64, "0");
const g1 = (p) => w(p[0]) + w(p[1]);
const g2 = (p) => w(p[0][1]) + w(p[0][0]) + w(p[1][1]) + w(p[1][0]);

/** vk JSON (snarkjs zkey export verificationkey) → hex string */
export function encodeVk(vk) {
  return g1(vk.vk_alpha_1) + g2(vk.vk_beta_2) + g2(vk.vk_gamma_2) + g2(vk.vk_delta_2) + vk.IC.map(g1).join("");
}

/** proof JSON (snarkjs groth16 prove) → hex string (256 bytes) */
export function encodeProof(proof) {
  return g1(proof.pi_a) + g2(proof.pi_b) + g1(proof.pi_c);
}

/** public signals (decimal strings) → hex string (32·n bytes) */
export function encodeInputs(publicSignals) {
  return publicSignals.map(w).join("");
}
