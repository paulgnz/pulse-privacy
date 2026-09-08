// Differential fuzzing of the contract's native primitives against the JavaScript references
// (circomlibjs for Poseidon and the curve, circuits/lib/notes.mjs for the tree), through the
// bench contract. Hundreds of random vectors plus the edge values, so a wrong reduction, a wrong
// constant or an off-by-one in the frontier shows up here before it shows up on chain.
//   node tests/fuzz.test.mjs [rounds]        (default 300; build:bench first)
import { Blockchain } from "@proton/vert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import N from "../../../circuits/lib/notes.mjs";

const ROUNDS = Number(process.argv[2] ?? 300);
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "../../../circuits/package.json"));
const { buildPoseidon } = require("circomlibjs");
const poseidon = await buildPoseidon();
await N.init();
const F = poseidon.F;
const p = F.p;
const hex = (n) => BigInt(n).toString(16).padStart(64, "0");
const rnd = () => BigInt("0x" + randomBytes(32).toString("hex")) % p;
const P = (...xs) => F.toObject(poseidon(xs.map((x) => F.e(x))));

const bc = new Blockchain();
const c = bc.createContract("shbench", join(HERE, "../assembly/target/shbench.contract"));
for (let i = 0; i < 400 && !c.actions.hash; i++) await new Promise((r) => setTimeout(r, 25));
assert.ok(c.actions.hash, "bench contract did not load (npm run build:bench)");
const run = async (action, args) => { bc.resetConsole?.(); bc.console = ""; await c.actions[action](args).send("shbench@active"); return (bc.console ?? "").trim(); };

// ---- Poseidon t=3 and t=6: random, and the edges 0, 1, p-1, small powers of two, equal inputs
const edges = [0n, 1n, 2n, p - 1n, p - 2n, 1n << 64n, (1n << 64n) - 1n, 1n << 128n, 1n << 253n]; // (2^254 - 1 is ≥ p: tested below as a refusal)
const pick = () => (Math.random() < 0.15 ? edges[Math.floor(Math.random() * edges.length)] : rnd());
let n3 = 0, n6 = 0;
for (let i = 0; i < ROUNDS; i++) {
  const a = pick(), b = i % 7 === 0 ? a : pick();
  assert.equal(await run("hash", { inputs: hex(a) + hex(b) }), hex(P(a, b)), `t=3 round ${i}: (${a}, ${b})`); n3++;
  if (i % 3 === 0) {
    const xs = [pick(), pick(), pick(), pick(), pick()];
    assert.equal(await run("hash", { inputs: xs.map(hex).join("") }), hex(P(...xs)), `t=6 round ${i}`); n6++;
  }
}
console.log(`ok  Poseidon: ${n3} t=3 and ${n6} t=6 vectors match circomlibjs (edges included)`);

// ---- non-canonical inputs (≥ p) are refused, never silently reduced
for (const v of [p, p + 1n, (1n << 256n) - 1n, p + (1n << 200n)]) {
  await assert.rejects(run("hash", { inputs: hex(v) + hex(1n) }), /not canonical/, `non-canonical ${v.toString(16).slice(0, 8)}… refused`);
}
console.log("ok  values ≥ p are refused");

// ---- point decompression: random keys both parities; y with no x (non-residue); y ≥ p; the identity
let dec = 0, nonPoints = 0;
for (let i = 0; i < Math.max(20, ROUNDS / 5); i++) {
  const k = N.keygen();
  const w = N.compressPoint(k.pk);
  assert.equal(await run("decomp", { w: hex(w) }), hex(k.pk[0]) + hex(k.pk[1]), `decompress ${i}`); dec++;
  // flip the parity bit: the other root, still on the curve, x = p - x
  const other = w ^ (1n << 255n);
  const got = await run("decomp", { w: hex(other) });
  assert.equal(got, hex(p - k.pk[0]) + hex(k.pk[1]), `decompress other parity ${i}`);
}
for (let i = 0; i < Math.max(20, ROUNDS / 5); i++) {
  let y = rnd();
  let isPoint = true;
  try { N.xFromY(y, 0n); } catch { isPoint = false; }
  if (isPoint) continue;
  await assert.rejects(run("decomp", { w: hex(y) }), /not a curve point/, `non-point y ${i}`); nonPoints++;
}
await assert.rejects(run("decomp", { w: hex(p + 5n) }), /not canonical|not a curve point/, "y ≥ p refused");
// y = 1 is the identity (0, 1): a valid curve point for decompression; `register` refuses it by the subgroup check
assert.equal(await run("decomp", { w: hex(1n) }), hex(0n) + hex(1n), "identity decompresses to (0, 1)");
console.log(`ok  decompression: ${dec} keys both parities; ${nonPoints} non-residues refused; y ≥ p refused`);

// ---- tree insertion: pairs at random indices across frontier levels, against the JS reference
// (the bench `insert` hashes a pair then climbs 20 levels with zero siblings: the empty-tree path)
for (let i = 0; i < Math.max(10, ROUNDS / 10); i++) {
  const cm1 = rnd(), cm2 = rnd();
  const index = i < 4 ? [0, 1, 2, 3][i] : Math.floor(Math.random() * (1 << 19));
  let node = P(cm1, cm2), z = 0n, idx = index;
  for (let level = 0; level < 20; level++) { node = (idx & 1) === 0 ? P(node, z) : P(z, node); z = P(z, z); idx >>= 1; }
  assert.equal(await run("insert", { cm1: hex(cm1), cm2: hex(cm2), index }), hex(node), `insert at pair index ${index}`);
}
console.log("ok  tree: pair insertion at random indices matches the JS reference");

// ---- the full tree kept by the contract: a sequence of appends equals notes.mjs Tree (via the JS model of the frontier)
{
  const t = new N.Tree();
  const leaves = Array.from({ length: 24 }, () => rnd());
  for (const l of leaves) t.append(l);
  // the reference for the contract's incremental root is the library's own tree; the contract is
  // exercised on this in xprshield.test.mjs with real deposits; here we check the library against
  // a from-scratch recomputation so the reference itself is trustworthy
  let level = leaves.slice();
  let z = 0n;
  for (let d = 0; d < 20; d++) {
    const next = [];
    for (let j = 0; j < level.length; j += 2) next.push(P(level[j], level[j + 1] ?? z));
    z = P(z, z);
    level = next;
  }
  assert.equal(level[0], t.root, "library tree root equals a from-scratch recomputation");
  console.log("ok  reference tree agrees with a from-scratch Merkle recomputation");
}
console.log(`all differential checks passed (${ROUNDS} rounds)`);
process.exit(0);
