// Regression for the tree rollover (circuit revision 6) and the root ring across trees. Distilled
// from the reviewer's adversarial run, whose section F found that the ring evicted a closed tree's
// final root 1,024 insertions after the rollover, freezing every unspent note of that tree. The
// contract now keeps a closed tree's final root for ever; section F asserts the inverse.
//
//   A. two deposits in tree 0, a proof for the first against tree 0's root (seq s0)
//   B. newtree: tree 1 active; tree 0's row keeps root_seq s0; the ring row s0 carries tree 0
//   C. circuit: a tree-1 note refused with tree = 0, with an index above 2^44, with a tree-0 index;
//      contract: a tree-1 proof refused against tree 0's root
//   D. a tree-0 note still spends right after the rollover (its root is in the ring); the outputs land in tree 1
//   E. the ring turns over with tree-1 deposits: RING+1 rows, tree 0's final root (seq s0) kept,
//      every other row older than RING evicted
//   F. the tree-0 note that was never spent still spends and withdraws by the row's root_seq
//   G. newtree on an empty active tree is refused; after a deposit it opens tree 2
// Needs `npm run build` and circuits/build/joinsplit_* (revision 6).
import { Blockchain, expectToThrow, nameToBigInt } from "@proton/vert";
import * as snarkjs from "snarkjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import N from "../../../circuits/lib/notes.mjs";
import { encodeInputs, encodeProof, encodeVk } from "../../../circuits/lib/encode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CB = (p) => join(HERE, "../../../circuits/build", p);
const WASM = CB("joinsplit_js/joinsplit.wasm");
const ZKEY = CB("joinsplit_final.zkey");
const VK = JSON.parse(readFileSync(CB("joinsplit_vk.json"), "utf8"));
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const hex = N.hex32;
const ptHex = (p) => hex(p[0]) + hex(p[1]);
const RING = 1024;

await N.init();
const alice = N.keygen(), bob = N.keygen(), auditor = N.keygen();
const ALICE = N.nameToU64("alice");

const bc = new Blockchain();
bc.createAccounts("alice", "bob");
const token = bc.createContract("eosio.token", join(HERE, "../node_modules/proton-tsc/external/eosio.token/eosio.token"));
const sh = bc.createContract("xprshield", join(HERE, "../assembly/target/xprshield.contract"));
for (let i = 0; i < 400 && !(sh.actions.spend && token.actions.transfer); i++) await new Promise((r) => setTimeout(r, 25));
assert.ok(sh.actions.spend, "xprshield did not load");
await token.actions.create(["eosio.token", "1000000000.0000 XPR"]).send("eosio.token@active");
await token.actions.issue(["eosio.token", "100000.0000 XPR", ""]).send("eosio.token@active");
await token.actions.transfer(["eosio.token", "alice", "50000.0000 XPR", "seed"]).send("eosio.token@active");

const scope = nameToBigInt("xprshield");
const treeRow = (id) => sh.tables.tree(scope).getTableRow(BigInt(id));
const config = () => sh.tables.config(scope).getTableRows()[0];
const rootRow = (seq) => sh.tables.roots(scope).getTableRow(BigInt(seq));
const rootRows = () => sh.tables.roots(scope).getTableRows();

await sh.actions.init([ptHex(auditor.pk), encodeVk(VK)]).send("xprshield@active");
await sh.actions.addtoken(["4,XPR", "eosio.token", "1", "0", "0", "0"]).send("xprshield@active");
await sh.actions.register(["alice", ptHex(alice.pk)]).send("alice@active");
await sh.actions.register(["bob", ptHex(bob.pk)]).send("bob@active");

const trees = new Map([[0, new N.Tree(20, 0)]]);
const dep = async (note) => {
  await token.actions.transfer(["alice", "xprshield", `${(Number(note.v) / 1e4).toFixed(4)} XPR`, `shield:${hex(note.r)}`]).send("alice@active");
  await sh.actions.deposit(["alice", hex(note.r)]).send("alice@active");
  const id = Number(config().active_tree);
  if (!trees.has(id)) trees.set(id, new N.Tree(20, id));
  const t = trees.get(id);
  const index = t.append(note.cm); t.append(0n);
  assert.equal(treeRow(id).root, hex(t.root), `tree ${id} root matches after a deposit`);
  return index;
};
const prove = async (js) => {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(js.input, WASM, ZKEY);
  return { proof: encodeProof(proof), publics: encodeInputs(N.actionPublics(js.expected)), publicSignals };
};
const spend = (who, p, seq, amount = "0", tok = 0) => sh.actions.spend([who, p.proof, p.publics, amount, tok, seq]);

// ---- A. two deposits in tree 0, a proof for the first ----
const a = N.newNote(alice.pk, 20000n, N.TOKENS.XPR);
const b = N.newNote(alice.pk, 30000n, N.TOKENS.XPR);
const ia = await dep(a);
const ib = await dep(b);
assert.equal(ia, 0); assert.equal(ib, 2);
const s0 = Number(treeRow(0).root_seq);
assert.equal(Number(rootRow(s0).tree), 0); assert.equal(rootRow(s0).root, treeRow(0).root);
const jsA = N.buildJoinSplit({ keys: alice, tree: trees.get(0), auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: a, index: ia }], outputs: [{ pk: bob.pk, v: 1n }, { pk: alice.pk, v: a.v - 1n }] });
const pA = await prove(jsA);
assert.equal(BigInt(pA.publicSignals[21]), 0n, "tree word 0 in the proof");
lap(`A. tree 0 has notes at ${ia} and ${ib}; proof for leaf ${ia} against seq ${s0}`);

// ---- B. newtree ----
await sh.actions.newtree([]).send("xprshield@active");
assert.equal(Number(config().active_tree), 1);
assert.equal(Number(treeRow(0).root_seq), s0, "tree 0's row keeps its final root sequence");
const s1open = Number(treeRow(1).root_seq);
assert.equal(s1open, s0 + 1, "opening a tree takes one ring slot");
assert.equal(Number(rootRow(s1open).tree), 1);
assert.equal(rootRow(s1open).root, hex(new N.Tree(20, 1).root), "the empty root of tree 1");
lap(`B. tree 1 opened at seq ${s1open}; tree 0 frozen at seq ${s0}`);

// ---- C. circuit and contract refusals across trees ----
const c = N.newNote(alice.pk, 40000n, N.TOKENS.XPR);
const ic = await dep(c);
await dep(N.newNote(alice.pk, 10000n, N.TOKENS.XPR)); // a sibling above the leaf level
assert.equal(ic, 2 ** 20, "first leaf of tree 1 is global 2^20");
const jsC = N.buildJoinSplit({ keys: alice, tree: trees.get(1), auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: c, index: ic }], outputs: [{ pk: bob.pk, v: 1n }, { pk: alice.pk, v: c.v - 1n }] });
const refused = async (mut, why) => {
  const input = structuredClone(jsC.input);
  mut(input);
  await assert.rejects(snarkjs.groth16.fullProve(input, WASM, ZKEY), /Assert Failed|Error/, why);
  lap(`C. circuit refused: ${why}`);
};
await refused((x) => { x.tree = 0n; }, "a tree-1 index with tree = 0");
await refused((x) => { x.inIndex[0] = BigInt(ic) + (1n << 44n); }, "an index with bit 44 set (same low 44 bits)");
await refused((x) => { x.inIndex[0] = BigInt(N.posOf(ic)); }, "the bare position (tree 0's index) with tree = 1");
await refused((x) => { x.tree = 1n << 24n; x.inIndex[0] = BigInt(ic) + (1n << 44n); }, "tree id 2^24 (contract caps trees below it)");
const pC = await prove(jsC);
assert.equal(BigInt(pC.publicSignals[21]), 1n, "tree word 1 in the proof");
await expectToThrow(spend("alice", pC, s0).send("alice@active"), "eosio_assert: invalid proof"); // tree 0's root and tree word
await expectToThrow(spend("alice", pC, s1open).send("alice@active"), "eosio_assert: invalid proof"); // tree 1's empty root
lap("C. contract refused a tree-1 proof against tree 0's root and against tree 1's empty root");

// ---- D. a tree-0 note spends right after the rollover; its outputs land in tree 1 ----
const jsB = N.buildJoinSplit({ keys: alice, tree: trees.get(0), auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: b, index: ib }], outputs: [{ pk: bob.pk, v: 5n }, { pk: alice.pk, v: b.v - 5n }] });
const pB = await prove(jsB);
const before1 = Number(treeRow(1).next_leaf);
await spend("alice", pB, s0).send("alice@active");
trees.get(1).append(jsB.outNotes[0].cm); trees.get(1).append(jsB.outNotes[1].cm);
assert.equal(treeRow(1).root, hex(trees.get(1).root), "the spend's outputs went into tree 1");
assert.equal(Number(treeRow(0).next_leaf), 4, "tree 0 untouched");
assert.equal(Number(treeRow(0).root_seq), s0, "tree 0's root_seq unchanged by a spend of its note");
assert.ok(sh.tables.outputs(scope).getTableRow(BigInt(2 ** 20 + before1)), "output row keyed by the global index in tree 1");
lap("D. a proof against tree 0's root (seq " + s0 + ") spent a tree-0 note after the rollover");

// ---- E. turn the ring over with tree-1 deposits; tree 0's final root survives ----
const seqE0 = Number(config().root_seq);
for (let n = 0; n < RING - (seqE0 - s0) + 5; n++) await dep(N.newNote(alice.pk, 10000n, N.TOKENS.XPR));
const seqNow = Number(config().root_seq);
assert.ok(seqNow - s0 > RING, "the ring has turned over since tree 0 closed");
assert.ok(rootRow(s0) !== undefined, "tree 0's final root row is still in the ring");
assert.equal(Number(rootRow(s0).tree), 0);
assert.equal(rootRow(s0).root, treeRow(0).root);
assert.equal(rootRows().length, RING + 1, "the ring holds RING rows plus tree 0's final root");
assert.equal(rootRow(s1open), undefined, "tree 1's empty root (not a final root) was evicted");
assert.equal(rootRow(seqNow - RING), undefined, "the row that fell off the ring this turn is gone");
lap(`E. seq ${seqNow}: ${rootRows().length} roots held, tree 0's final root (seq ${s0}) among them`);

// ---- F. the unspent tree-0 note still spends by the tree row's root_seq ----
await spend("alice", pA, Number(treeRow(0).root_seq)).send("alice@active");
trees.get(1).append(jsA.outNotes[0].cm); trees.get(1).append(jsA.outNotes[1].cm);
assert.equal(treeRow(1).root, hex(trees.get(1).root), "the spend's outputs went into tree 1");
// and a withdrawal of a later tree-0 note works the same way: the exit stays open
const jwC = N.buildJoinSplit({ keys: alice, tree: trees.get(1), auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: c, index: ic }], outputs: [{ pk: alice.pk, v: 0n }, { pk: alice.pk, v: 0n }], vPub: c.v, tokenPub: N.TOKENS.XPR, to: ALICE });
await expectToThrow(spend("alice", await prove(jwC), Number(treeRow(1).root_seq) - 1, c.v.toString(), 1).send("alice@active"), "eosio_assert: invalid proof"); // stale tree-1 root: the proof was built on the current one
await expectToThrow(spend("alice", pA, Number(treeRow(0).root_seq)).send("alice@active"), "eosio_assert: note already spent");
lap("F. the tree-0 note at leaf " + ia + " spent " + (seqNow - s0) + " insertions after its tree closed");

// ---- G. newtree refuses an empty active tree ----
await sh.actions.newtree([]).send("xprshield@active");
assert.equal(Number(config().active_tree), 2);
await expectToThrow(sh.actions.newtree([]).send("xprshield@active"), "eosio_assert: the active tree is empty; nothing to roll over");
assert.deepEqual(sh.tables.tree(scope).getTableRows().map((r) => Number(r.id)), [0, 1, 2]);
const d = await dep(N.newNote(alice.pk, 10000n, N.TOKENS.XPR));
assert.equal(d, 2 * 2 ** 20, "a deposit after newtree lands in tree 2");
assert.ok(rootRow(Number(treeRow(1).root_seq)) !== undefined, "tree 1's final root is kept once tree 1 closed");
lap("G. newtree refused on the empty tree 2; a deposit landed in tree 2; tree 1's final root kept");
console.log("rollover-ring checks done");
process.exit(0);
