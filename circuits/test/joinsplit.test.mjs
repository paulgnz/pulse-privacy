// Shielded join-split, end to end (milestone S2):
//   1. alice and bob register keys; alice's deposit notes go into the tree
//   2. alice pays bob 1,234 XPR from two notes: witness satisfies the circuit
//   3. bob finds his note by trial decryption; the auditor reads sender, receiver and amount
//   4. wrong root, overspend, wrong owner and a redirected withdrawal are refused
//   5. with build/joinsplit_final.zkey: prove, verify, and check the public-signal order
//   node test/joinsplit.test.mjs [--witness-only]
import * as snarkjs from "snarkjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import N from "../lib/notes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const B = (p) => join(HERE, "..", "build", p);
const witnessOnly = process.argv.includes("--witness-only");
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const wasm = B("joinsplit_js/joinsplit.wasm");
const satisfies = async (input) => { await snarkjs.wtns.calculate(input, wasm, { type: "mem" }); };
const refuses = async (input, why) => { await assert.rejects(satisfies(input), undefined, why); lap(`refused: ${why}`); };

await N.init();
const alice = N.keygen(), bob = N.keygen(), auditor = N.keygen();
lap("keys");

// deposits: alice 5,000 XPR and 700 XPR (base units: 4 decimals), a stranger's note in between
const tree = new N.Tree();
const a1 = N.newNote(alice.pk, 50_000_000n, N.TOKENS.XPR);
const s1 = N.newNote(N.keygen().pk, 1n, N.TOKENS.XPR);
const a2 = N.newNote(alice.pk, 7_000_000n, N.TOKENS.XPR);
const i1 = tree.append(a1.cm), _s = tree.append(s1.cm), i2 = tree.append(a2.cm);
lap(`tree has ${tree.size} notes, root ${N.hex32(tree.root).slice(0, 12)}…`);

// alice pays bob 1,234 XPR using both notes; change back to alice
const AMOUNT = 12_340_000n;
const ALICE = N.nameToU64("alice");
const js = N.buildJoinSplit({
  keys: alice, tree, auditorPk: auditor.pk, sender: ALICE,
  inputs: [{ note: a1, index: i1 }, { note: a2, index: i2 }],
  outputs: [{ pk: bob.pk, v: AMOUNT }, { pk: alice.pk, v: a1.v + a2.v - AMOUNT }],
});
await satisfies(js.input);
lap("witness ok: two inputs, two outputs");

// single input (dummy second)
const js1 = N.buildJoinSplit({ keys: alice, tree, auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: a2, index: i2 }], outputs: [{ pk: bob.pk, v: 1_000_000n }, { pk: alice.pk, v: 6_000_000n }] });
await satisfies(js1.input);
assert.equal(js1.expected.nf[1], 0n);
lap("witness ok: one input, dummy second (nf = 0)");

// withdrawal of 500 XPR to "bob" (name bound)
const jw = N.buildJoinSplit({ keys: alice, tree, auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: a2, index: i2 }], outputs: [{ pk: alice.pk, v: 0n }, { pk: alice.pk, v: a2.v - 5_000_000n }], vPub: 5_000_000n, tokenPub: N.TOKENS.XPR, to: ALICE });
await satisfies(jw.input);
lap("witness ok: withdrawal with the destination bound");

// receiver and auditor decryption
const found = N.tryDecryptReceiver(bob, js.expected.epk[0], js.expected.cr[0], js.expected.cm[0]);
assert.ok(found && found.v === AMOUNT && found.token === N.TOKENS.XPR, "bob decrypts his note");
assert.equal(N.tryDecryptReceiver(bob, js.expected.epk[1], js.expected.cr[1], js.expected.cm[1]), null, "bob cannot claim alice's change");
const aud = N.decryptAuditor(auditor.ask, js.expected.epk[0], js.expected.ca[0], js.expected.cm[0]);
assert.ok(aud.valid && aud.v === AMOUNT && aud.token === N.TOKENS.XPR && aud.pk[0] === bob.pk[0], "auditor reads receiver and amount");
assert.deepEqual(js.expected.senderPk, alice.pk, "the sender's key is a public output");
lap(`bob reads ${found.v} units; auditor reads ${aud.v} units to bob's key; sender key public`);

// negatives
const bad = (mut) => { const x = structuredClone(js.input); mut(x); return x; };
await refuses(bad((x) => { x.root = tree.root + 1n; }), "wrong root");
await refuses(bad((x) => { x.outV[0] = x.outV[0] + 1n; }), "values do not balance");
await refuses(bad((x) => { x.ask = bob.ask; }), "not the owner");
await refuses(bad((x) => { x.inIndex[0] = BigInt(i2); }), "wrong leaf index");
{
  const x = structuredClone(jw.input); x.to = N.nameToU64("mallory"); x.sender = N.nameToU64("mallory");
  // the witness itself still computes (to is only bound); the proof would carry the other name
  await satisfies(x);
  assert.notEqual(x.to, jw.input.to);
  lap("withdrawal destination is a public input: changing it changes the statement");
}
await refuses(bad((x) => { x.vPub = 5n; x.tokenPub = N.TOKENS.XMD; }), "withdrawal token mismatch");

if (witnessOnly || !existsSync(B("joinsplit_final.zkey"))) {
  console.log(witnessOnly ? "witness-only run: done" : "no zkey yet (npm run setup:shielded): stopping before prove");
  process.exit(0);
}

const { proof, publicSignals } = await snarkjs.groth16.fullProve(js.input, wasm, B("joinsplit_final.zkey"));
lap(`proof generated (${publicSignals.length} public signals)`);
const vk = JSON.parse(readFileSync(B("joinsplit_vk.json"), "utf8"));
assert.ok(await snarkjs.groth16.verify(vk, publicSignals, proof), "snarkjs verify");
lap("snarkjs verify ok");
const expectedSignals = N.publicSignals(js.expected, { root: tree.root, sender: ALICE, A: auditor.pk });
assert.deepEqual(publicSignals.map(BigInt), expectedSignals, "public signal order matches the library");
lap("public signals match the library's recomputation");
// a wrong destination on a withdrawal proof fails verification
const { proof: pw, publicSignals: psw } = await snarkjs.groth16.fullProve(jw.input, wasm, B("joinsplit_final.zkey"));
const redirected = psw.slice(); redirected[psw.length - 4] = N.nameToU64("mallory").toString();
assert.equal(await snarkjs.groth16.verify(vk, redirected, pw), false, "redirected withdrawal rejected");
const resigned = psw.slice(); resigned[psw.length - 3] = N.nameToU64("mallory").toString();
assert.equal(await snarkjs.groth16.verify(vk, resigned, pw), false, "proof bound to another signer rejected");
const swappedKey = psw.slice(); swappedKey[24] = bob.pk[0].toString(); swappedKey[25] = bob.pk[1].toString();
assert.equal(await snarkjs.groth16.verify(vk, swappedKey, pw), false, "sender key cannot be substituted");
lap("redirected destination, other signer and substituted sender key all rejected");
console.log("S7 join-split (signed sender) passed");
process.exit(0);
