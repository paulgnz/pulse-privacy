// Regression for the headless client's reading of the outputs table: a single node that pads the
// table with a fractional index (a copy of a real row at index n + 0.5, so the root still matches)
// must be refused as malformed, not crash the scan with a BigInt conversion error. Reads the live
// testnet tables; no key and no signing involved.
//   node client/tests/lying-node.test.mjs
import assert from "node:assert/strict";
import N from "../../circuits/lib/notes.mjs";
import { Net } from "../lib/net.mjs";

await N.init();
const net = new Net("testnet");
const { trees } = await net.treeRows();
const outs = await net.tableAny("outputs");
assert.ok(trees.length >= 1 && outs.length >= 1, "testnet has trees and outputs");
net.rebuildAll(trees, outs);
console.log(`ok  honest outputs rebuild ${trees.length} tree(s)`);
const real = outs[outs.length - 1];
for (const bad of [Number(real.index) + 0.5, -1, Number(real.index) - 0.25]) {
  assert.throws(() => net.rebuildAll(trees, [...outs, { ...real, index: bad }]), /malformed outputs/, `index ${bad} refused`);
  console.log(`ok  a row at index ${bad} is refused as malformed`);
}
console.log("client lying-node checks done");
