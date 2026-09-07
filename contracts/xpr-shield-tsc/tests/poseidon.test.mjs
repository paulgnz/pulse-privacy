// Conformance: the contract's Poseidon must equal circomlibjs bit for bit, for t = 3 and t = 7,
// and the tree insertion must equal a JS reference. Run after `npm run build:bench`.
import { Blockchain } from "@proton/vert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "../../../circuits/package.json"));
const { buildPoseidon } = require("circomlibjs");
const poseidon = await buildPoseidon();
const F = poseidon.F;
const r = F.p;

const hex = (n) => n.toString(16).padStart(64, "0");
const rnd = () => BigInt("0x" + randomBytes(32).toString("hex")) % r;
const P = (...xs) => F.toObject(poseidon(xs.map((x) => F.e(x))));

const bc = new Blockchain();
const c = bc.createContract("shbench", join(HERE, "../assembly/target/shbench.contract"));
for (let i = 0; i < 400 && !c.actions.hash; i++) await new Promise((res) => setTimeout(res, 25));
assert.ok(c.actions.hash, "contract did not load");

let lastConsole = "";
bc.console = "";
const run = async (action, args) => {
  bc.resetConsole?.();
  bc.console = "";
  await c.actions[action](args).send("shbench@active");
  lastConsole = (bc.console ?? "").trim();
  return lastConsole;
};

// known vector: Poseidon(1, 2)
const known = await run("hash", { inputs: hex(1n) + hex(2n) });
assert.equal(known, "115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a", "Poseidon(1,2) known vector");
console.log("ok  Poseidon(1,2) matches the published vector");

for (let i = 0; i < 5; i++) {
  const a = rnd(), b = rnd();
  const got = await run("hash", { inputs: hex(a) + hex(b) });
  assert.equal(got, hex(P(a, b)), `t=3 random ${i}`);
}
console.log("ok  t=3 matches circomlibjs on 5 random inputs");

for (let i = 0; i < 3; i++) {
  const xs = [rnd(), rnd(), rnd(), rnd(), rnd(), rnd()];
  const got = await run("hash", { inputs: xs.map(hex).join("") });
  assert.equal(got, hex(P(...xs)), `t=7 random ${i}`);
}
console.log("ok  t=7 matches circomlibjs on 3 random inputs");

// edge: the largest canonical element and zero
const edge = await run("hash", { inputs: hex(r - 1n) + hex(0n) });
assert.equal(edge, hex(P(r - 1n, 0n)), "edge (r-1, 0)");
await assert.rejects(run("hash", { inputs: hex(r) + hex(0n) }), /not canonical/, "non-canonical input refused");
console.log("ok  edge values and the canonical check");

// tree insertion: pair leaf, then 20 levels with zero-chain siblings
const cm1 = rnd(), cm2 = rnd(), index = 5;
let node = P(cm1, cm2), z = 0n, idx = index;
for (let level = 0; level < 20; level++) { node = (idx & 1) === 0 ? P(node, z) : P(z, node); z = P(z, z); idx >>= 1; }
const root = await run("insert", { cm1: hex(cm1), cm2: hex(cm2), index });
assert.equal(root, hex(node), "insert root");
console.log("ok  21-hash insertion matches the JS reference");

// bench smoke: a chain of hashes agrees with JS
let acc = 1n;
for (let i = 0; i < 50; i++) acc = P(acc, 1n);
assert.equal(await run("bench", { n: 50 }), hex(acc), "bench chain");
console.log("ok  bench(50) chain matches");
console.log("all Poseidon conformance checks passed");
