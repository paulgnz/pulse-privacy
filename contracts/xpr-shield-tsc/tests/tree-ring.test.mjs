// Adversarial review checks (2026-09-08): the contract's incremental Merkle tree against the
// library's Tree across frontier crossings up to level 11, the 1,024-root ring under eviction
// with a real proof, and point decompression edge cases through the bench contract.
// Needs `npm run build` and circuits/build/joinsplit_*.
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

await N.init();
const F = N.F;
const alice = N.keygen(), auditor = N.keygen();
const ALICE = N.nameToU64("alice");

const bc = new Blockchain();
bc.createAccounts("alice", "bob");
const token = bc.createContract("eosio.token", join(HERE, "../node_modules/proton-tsc/external/eosio.token/eosio.token"));
const sh = bc.createContract("xprshield", join(HERE, "../assembly/target/xprshield.contract"));
const bench = bc.createContract("shbench", join(HERE, "../assembly/target/shbench.contract"));
for (let i = 0; i < 400 && !(sh.actions.spend && token.actions.transfer && bench.actions.decomp); i++) await new Promise((r) => setTimeout(r, 25));
await token.actions.create(["eosio.token", "1000000000.0000 XPR"]).send("eosio.token@active");
await token.actions.issue(["eosio.token", "100000.0000 XPR", ""]).send("eosio.token@active");
await token.actions.transfer(["eosio.token", "alice", "20000.0000 XPR", "seed"]).send("eosio.token@active");

const scope = nameToBigInt("xprshield");
const treeRow = () => sh.tables.tree(scope).getTableRow(0n);
const rootRows = () => sh.tables.roots(scope).getTableRows();

// ---- decompression edge cases through the bench contract ----
{
  const run = async (w) => { bc.console = ""; await bench.actions.decomp({ w: hex(w) }).send("shbench@active"); return (bc.console ?? "").trim(); };
  // identity (0, 1): word 1
  assert.equal(await run(1n), hex(0n) + hex(1n), "identity decompresses");
  // order-2 point (0, -1)
  assert.equal(await run(F.p - 1n), hex(0n) + hex(F.p - 1n), "order-2 point decompresses");
  // x = 0 with the parity bit set: parity cannot be honoured, the contract returns x = 0 anyway
  assert.equal(await run(1n | (1n << 255n)), hex(0n) + hex(1n), "identity with parity 1 is accepted as (0,1)");
  // order-4 points (x, 0): x^2 = 1/a
  const [x4] = N.decompressPoint(0n);
  assert.equal(await run(0n), hex(x4) + hex(0n), "order-4 point (x,0) even parity");
  assert.equal(await run(1n << 255n), hex(F.p - x4) + hex(0n), "order-4 point (x,0) odd parity");
  // non-canonical y (y = p, y = p + small) refused
  await assert.rejects(run(F.p), /y not canonical/);
  await assert.rejects(run(F.p | (1n << 255n)), /y not canonical/);
  await assert.rejects(run((1n << 254n) | 5n), /y not canonical/);
  // 40 random subgroup points and their negations
  for (let i = 0; i < 40; i++) {
    const k = N.keygen();
    const P = k.pk, Q = [F.p - P[0], P[1]];
    assert.equal(await run(N.compressPoint(P)), ptHex(P), `decompress ${i}`);
    assert.equal(await run(N.compressPoint(Q)), ptHex(Q), `decompress neg ${i}`);
  }
  // 20 random non-points refused
  let refused = 0;
  for (let y = 2n; refused < 20; y += 1n) {
    let ok = true; try { N.xFromY(y, 0n); } catch { ok = false; }
    if (ok) continue;
    await assert.rejects(run(y), /not a curve point/); refused++;
  }
  lap("decompression: identity, order 2/4, non-canonical y, 80 subgroup points, 20 non-points");
}

// ---- init / register ----
await sh.actions.init([ptHex(auditor.pk), encodeVk(VK)]).send("xprshield@active");
await sh.actions.addtoken(["4,XPR", "eosio.token", "1", "0", "0", "0"]).send("xprshield@active");
await sh.actions.register(["alice", ptHex(alice.pk)]).send("alice@active");
const local = new N.Tree();
assert.equal(treeRow().root, hex(local.root));
assert.equal(Number(treeRow().root_seq), 1, "seq 1 after init");
assert.deepEqual(rootRows().map((r) => Number(r.seq)), [1]);

const dep = async (note) => {
  await token.actions.transfer(["alice", "xprshield", `${(Number(note.v) / 1e4).toFixed(4)} XPR`, `shield:${hex(note.r)}`]).send("alice@active");
  await sh.actions.deposit(["alice", hex(note.r)]).send("alice@active");
  const index = local.append(note.cm); local.append(0n);
  return index;
};

// ---- a note early on, and a proof against the root right after it, to age through the ring ----
const early = N.newNote(alice.pk, 10000n, N.TOKENS.XPR);
const earlyIdx = await dep(early);
const jsEarly = N.buildJoinSplit({ keys: alice, tree: local, auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: early, index: earlyIdx }], outputs: [{ pk: alice.pk, v: 1n }, { pk: alice.pk, v: 9999n }] });
const earlySeq = Number(treeRow().root_seq);
const { proof: pr, publicSignals } = await snarkjs.groth16.fullProve(jsEarly.input, WASM, ZKEY);
const pEarly = { proof: encodeProof(pr), publics: encodeInputs(N.actionPublics(jsEarly.expected)) };
assert.equal(BigInt(publicSignals[20]), local.root);
lap(`early note at leaf ${earlyIdx}, proof against seq ${earlySeq}`);

// ---- 1,030 more deposits: root checked against the library after each; frontier crosses level 11 ----
const TOTAL = 1030;
for (let i = 0; i < TOTAL; i++) {
  await dep(N.newNote(alice.pk, 10000n, N.TOKENS.XPR));
  const row = treeRow();
  assert.equal(row.root, hex(local.root), `root after deposit ${i} (leaf ${local.size - 2})`);
  assert.equal(Number(row.next_leaf), local.size);
  const seq = Number(row.root_seq);
  assert.equal(seq, earlySeq + 1 + i, "seq increments once per insertion");
  if (i % 200 === 0 || i === TOTAL - 1) {
    const seqs = rootRows().map((r) => Number(r.seq));
    const expected = seq <= 1024 ? seq : 1024;
    assert.equal(seqs.length, expected, `ring holds ${expected} roots at seq ${seq}`);
    assert.equal(seqs[0], Math.max(1, seq - 1023), "oldest kept root");
    assert.equal(seqs[seqs.length - 1], seq, "current root kept");
    const cur = sh.tables.roots(scope).getTableRow(BigInt(seq));
    assert.equal(cur.root, row.root, "ring's newest entry equals the tree's root");
    lap(`deposit ${i}: leaves ${local.size}, seq ${seq}, ring ${seqs[0]}..${seqs[seqs.length - 1]}`);
  }
  // half way: the early root is still in the ring and the early proof still verifies against it
  if (i === 1020) {
    const seqNow = Number(treeRow().root_seq);
    assert.ok(seqNow - earlySeq < 1024 && sh.tables.roots(scope).getTableRow(BigInt(earlySeq)), "early root still held");
  }
}
// the early root (seq 2) is now evicted; the proof must be refused, and no other seq can substitute it
assert.equal(sh.tables.roots(scope).getTableRow(BigInt(earlySeq)), undefined, "early root evicted");
await expectToThrow(sh.actions.spend(["alice", pEarly.proof, pEarly.publics, "0", 0, earlySeq]).send("alice@active"), "eosio_assert: unknown or stale root");
await expectToThrow(sh.actions.spend(["alice", pEarly.proof, pEarly.publics, "0", 0, 0]).send("alice@active"), "eosio_assert: unknown or stale root");
await expectToThrow(sh.actions.spend(["alice", pEarly.proof, pEarly.publics, "0", 0, Number(treeRow().root_seq)]).send("alice@active"), "eosio_assert: invalid proof");
lap("evicted root refused; seq 0 refused; neighbouring root does not verify the proof");

// ---- a fresh proof against the oldest surviving root still spends; then that root is evicted by one insertion ----
const seqNow = Number(treeRow().root_seq);
const oldest = seqNow - 1023;
assert.ok(sh.tables.roots(scope).getTableRow(BigInt(oldest)), "oldest root present");
// build against the current tree, name the current seq: the plain path
const last = N.newNote(alice.pk, 10000n, N.TOKENS.XPR);
const lastIdx = await dep(last);
const jsLast = N.buildJoinSplit({ keys: alice, tree: local, auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: last, index: lastIdx }], outputs: [{ pk: alice.pk, v: 5000n }, { pk: alice.pk, v: 5000n }] });
const { proof: pr2 } = await snarkjs.groth16.fullProve(jsLast.input, WASM, ZKEY);
const seqLast = Number(treeRow().root_seq);
await sh.actions.spend(["alice", encodeProof(pr2), encodeInputs(N.actionPublics(jsLast.expected)), "0", 0, seqLast]).send("alice@active");
local.append(jsLast.outNotes[0].cm); local.append(jsLast.outNotes[1].cm);
assert.equal(treeRow().root, hex(local.root), "root after a spend at leaf " + lastIdx);
assert.equal(sh.tables.roots(scope).getTableRow(BigInt(oldest)), undefined, "the oldest root was evicted by the deposit");
lap(`spend at leaf ${lastIdx} matched the library; ring turned over cleanly`);
console.log("review tree/ring checks passed");
process.exit(0);
