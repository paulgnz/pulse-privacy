// Local test of the Groth16 verifier under @proton/vert (which simulates alt_bn128_* with a
// real bn128 implementation). Fixture: an arkworks proof exported in EIP-196/197 encoding by
//   (cd ../../bench && cargo run --release -- --emit-evm-fixture ../contracts/xpr-conf-tsc/tests/fixtures/groth16_2_evm.json)
import { Blockchain, expectToThrow } from "@proton/vert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(HERE, "fixtures/groth16_2_evm.json"), "utf8"));

// helpers: "0x…" (32-byte word) → hex without prefix; arrays of words → concatenated hex
const w = (s) => s.replace(/^0x/, "").padStart(64, "0");
const g1 = (p) => w(p[0]) + w(p[1]);
const g2 = (p) => w(p[0]) + w(p[1]) + w(p[2]) + w(p[3]);

export const encode = (fx) => ({
  vk: g1(fx.vk.alpha) + g2(fx.vk.beta) + g2(fx.vk.gamma) + g2(fx.vk.delta) + fx.vk.ic.map(g1).join(""),
  proof: g1(fx.proof.a) + g2(fx.proof.b) + g1(fx.proof.c),
  inputs: fx.inputs.map(w).join(""),
});

const { vk, proof, inputs } = encode(fx);

const blockchain = new Blockchain();
const contract = blockchain.createContract("verifier", join(HERE, "../assembly/target/groth16.contract"));
// vert wires `actions` after it has loaded the wasm+abi asynchronously; wait for it.
for (let i = 0; i < 200 && !contract.actions.verify; i++) await new Promise((r) => setTimeout(r, 25));
if (!contract.actions.verify) throw new Error("contract did not load (check assembly/target)");

// 1. valid proof verifies
await contract.actions.verify([vk, proof, inputs]).send("verifier@active");
console.log("✓ valid proof accepted", `(n_pub=${fx.n_pub}, vk ${vk.length / 2} B, proof ${proof.length / 2} B)`);

// 2. a tampered public input is rejected
const badInputs = inputs.slice(0, -2) + (inputs.endsWith("00") ? "01" : "00");
await expectToThrow(contract.actions.verify([vk, proof, badInputs]).send("verifier@active"), "eosio_assert: invalid proof");
console.log("✓ tampered input rejected");

// 3. a tampered proof is rejected
const badProof = proof.slice(0, 2) + (proof.startsWith("00") ? "01" : "00") + proof.slice(4);
// the tampered A is no longer on the curve, so the host function itself rejects it
await expectToThrow(contract.actions.verify([vk, badProof, inputs]).send("verifier@active"), "eosio_assert: bn128Pair error");
console.log("✓ tampered proof rejected");

console.log("all groth16 tests passed");
