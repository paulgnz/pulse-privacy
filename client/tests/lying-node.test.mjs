// Regression for the headless client's reading of the outputs table. Deterministic: the trees
// and the outputs table are built locally with the note library, exactly as the contract would
// publish them, so the test never touches a node. A single node that pads the table with a row at
// a fractional or negative index (a copy of a real row, so the root still matches) must be refused
// as malformed, not crash the scan with a BigInt conversion error.
//   node client/tests/lying-node.test.mjs
import assert from "node:assert/strict";
import N from "../../circuits/lib/notes.mjs";
import { Net } from "../lib/net.mjs";

await N.init();
const net = new Net("testnet"); // only for rebuildAll, a pure function of its arguments
const hex = N.hex32;
const pk = N.keygen(7n).pk;

// two trees as the contract leaves them after a rollover: tree 0 closed with four leaves, tree 1 active with six
const outs = [];
const trees = [];
let seq = 0n;
for (const [id, count] of [[0, 4], [1, 6]]) {
  const t = new N.Tree(N.DEPTH, id);
  for (let i = 0; i < count; i++) {
    const note = N.newNote(pk, BigInt(1000 + i), N.TOKENS.XPR);
    const g = t.append(note.cm);
    outs.push({ index: g, cm: hex(note.cm), epk: "", cr: "0".repeat(128), ca: "" });
    seq += 1n;
  }
  trees.push({ id, next: count, root: hex(t.root), rootSeq: seq });
}
const honest = net.rebuildAll(trees, outs);
assert.deepEqual([...honest.keys()], [0, 1]);
assert.equal(hex(honest.get(1).root), trees[1].root);
console.log("ok  honest outputs rebuild both trees to the agreed roots");

const real = outs[outs.length - 1];
for (const bad of [Number(real.index) + 0.5, -1, Number(real.index) - 0.25, 2 ** 20 + 0.5]) {
  assert.throws(() => net.rebuildAll(trees, [...outs, { ...real, index: bad }]), /malformed outputs/, `index ${bad} refused`);
  console.log(`ok  a padded row at index ${bad} is refused as malformed`);
}
// a duplicate position and a row with a foreign commitment are refused too
assert.throws(() => net.rebuildAll(trees, [...outs, { ...real }]), /malformed outputs/);
assert.throws(() => net.rebuildAll(trees, outs.map((o, i) => (i === 2 ? { ...o, cm: hex(123n) } : o))), /do not hash to the agreed root/);
console.log("ok  a duplicate position and a swapped commitment are refused");

// recipient keys: KEY_QUORUM distinct operators must agree and none may differ (mainnet quorum 3)
const K = (n) => N.hex32(N.keygen(BigInt(n)).pk[0]) + N.hex32(N.keygen(BigInt(n)).pk[1]);
const main = new Net("mainnet");
const withTables = async (byEndpoint) => {
  main.table = async (ep, table) => { if (table !== "keys") throw new Error("unexpected"); if (!(ep in byEndpoint)) throw new Error("down"); return Object.entries(byEndpoint[ep]).map(([owner, pubkey]) => ({ owner, pubkey })); };
  try { return { keys: await main.registeredKeys(), disputed: main.disputedKeys }; } catch (e) { return { error: e.message }; }
};
const [E1, E2, E3, E4] = main.endpoints; // protonnz, saltant, cryptolions, eosiomadrid
let r = await withTables({ [E1]: { bob: K(11) }, [E2]: { bob: K(11) }, [E3]: { bob: K(11) } });
assert.ok(r.keys.has("bob"), "three operators agreeing confirm a key");
r = await withTables({ [E1]: { bob: K(11) }, [E2]: { bob: K(99) }, [E3]: { bob: K(99) }, [E4]: { bob: K(99) } });
assert.ok(!r.keys.has("bob") && r.disputed.has("bob"), "one dissenting operator blocks the name instead of being outvoted");
r = await withTables({ [E1]: { bob: K(11) }, [E2]: { bob: K(11) } });
assert.match(r.error ?? "", /independent node operators/, "two operators are not enough on mainnet");
const twoHostsOneOp = { ...Object.fromEntries(main.endpoints.map((e) => [e, null])) };
main.endpoints = ["https://api.protonnz.com", "https://tn1.protonnz.com", "https://proton.cryptolions.io"];
r = await withTables({ "https://api.protonnz.com": { bob: K(66) }, "https://tn1.protonnz.com": { bob: K(66) }, "https://proton.cryptolions.io": { bob: K(66) } });
assert.match(r.error ?? "", /independent node operators/, "two hostnames of one operator count once");
console.log("ok  recipient keys need 3 distinct operators, a single dissent blocks, one operator's hostnames count once");
console.log("client lying-node checks done");
