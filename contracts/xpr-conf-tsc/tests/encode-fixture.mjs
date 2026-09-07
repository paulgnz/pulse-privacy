// Print the `verify` action payload (JSON) for a fixture, for `proton action` on testnet:
//   node tests/encode-fixture.mjs [tests/fixtures/groth16_2_evm.json] [--tamper]
import { readFileSync } from "node:fs";
const path = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "tests/fixtures/groth16_2_evm.json";
const tamper = process.argv.includes("--tamper");
const fx = JSON.parse(readFileSync(path, "utf8"));
const w = (s) => s.replace(/^0x/, "").padStart(64, "0");
const g1 = (p) => w(p[0]) + w(p[1]);
const g2 = (p) => w(p[0]) + w(p[1]) + w(p[2]) + w(p[3]);
let inputs = fx.inputs.map(w).join("");
if (tamper) inputs = inputs.slice(0, -2) + (inputs.endsWith("00") ? "01" : "00");
console.log(JSON.stringify({
  vk: g1(fx.vk.alpha) + g2(fx.vk.beta) + g2(fx.vk.gamma) + g2(fx.vk.delta) + fx.vk.ic.map(g1).join(""),
  proof: g1(fx.proof.a) + g2(fx.proof.b) + g1(fx.proof.c),
  inputs,
}));
