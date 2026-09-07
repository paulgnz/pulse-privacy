// S3 end to end under vert: eosio.token + xprshield with real join-split proofs.
//   init, addtoken, register → alice deposits 5,000 and 700 XPR (tree matches the library)
//   → relay submits alice → bob 1,234 XPR (no party in the transaction) → bob finds his note
//   → double spend, stale-but-known root, wrong auditor key, tampered publics, redirect,
//     pause are all handled → bob withdraws 1,000 XPR to his public account.
// Needs circuits/build/joinsplit_* (npm run compile:shielded && npm run setup:shielded).
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
const units = (xpr) => BigInt(Math.round(xpr * 1e4));
const hex = N.hex32;
const ptHex = (p) => hex(p[0]) + hex(p[1]);

await N.init();
const alice = N.keygen(), bob = N.keygen(), auditor = N.keygen();

const bc = new Blockchain();
bc.createAccounts("alice", "bob", "relay");
const token = bc.createContract("eosio.token", join(HERE, "../node_modules/proton-tsc/external/eosio.token/eosio.token"));
const sh = bc.createContract("xprshield", join(HERE, "../assembly/target/xprshield.contract"));
for (let i = 0; i < 400 && !(sh.actions.transfer && token.actions.transfer); i++) await new Promise((r) => setTimeout(r, 25));
assert.ok(sh.actions.transfer, "xprshield did not load");
await token.actions.create(["eosio.token", "1000000000.0000 XPR"]).send("eosio.token@active");
await token.actions.issue(["eosio.token", "100000.0000 XPR", ""]).send("eosio.token@active");
await token.actions.transfer(["eosio.token", "alice", "10000.0000 XPR", "seed"]).send("eosio.token@active");
lap("chain ready");

const scope = nameToBigInt("xprshield");
const treeRow = () => sh.tables.tree(scope).getTableRow(0n);
const leaves = () => sh.tables.leaves(scope).getTableRows();
const nullifiers = () => sh.tables.nullifiers(scope).getTableRows();
const balance = (acct) => { const r = token.tables.accounts(nameToBigInt(acct)).getTableRows(); return r.length ? r[0].balance : "0.0000 XPR"; };

// --- init / addtoken / register ---
await sh.actions.init([ptHex(auditor.pk), encodeVk(VK)]).send("xprshield@active");
await sh.actions.addtoken(["4,XPR", "eosio.token", "1", "0", "0"]).send("xprshield@active");
await sh.actions.register(["alice", ptHex(alice.pk)]).send("alice@active");
await sh.actions.register(["bob", ptHex(bob.pk)]).send("bob@active");
await expectToThrow(sh.actions.register(["bob", ptHex(bob.pk)]).send("bob@active"), "eosio_assert: already registered");
await expectToThrow(sh.actions.register(["relay", hex(alice.pk[0]) + hex(alice.pk[1] + 1n)]).send("relay@active"), "eosio_assert: pubkey not on curve");
const local = new N.Tree();
assert.equal(treeRow().root, hex(local.root), "empty root matches");
lap("init + register; empty root matches the library");

// --- deposits: the contract computes the commitment and inserts (cm, empty) ---
const dep = async (note) => {
  await token.actions.transfer(["alice", "xprshield", `${(Number(note.v) / 1e4).toFixed(4)} XPR`, `shield:${hex(note.rho)}:${hex(note.r)}`]).send("alice@active");
  const index = local.append(note.cm); local.append(0n);
  return index;
};
const a1 = N.newNote(alice.pk, units(5000), N.TOKENS.XPR);
const a2 = N.newNote(alice.pk, units(700), N.TOKENS.XPR);
const i1 = await dep(a1);
const i2 = await dep(a2);
assert.deepEqual(leaves().map((l) => [Number(l.index), l.cm]), [[0, hex(a1.cm)], [2, hex(a2.cm)]], "leaves recorded at even indexes");
assert.equal(treeRow().root, hex(local.root), "root after two deposits matches");
assert.equal(Number(treeRow().next_leaf), 4);
await expectToThrow(token.actions.transfer(["alice", "xprshield", "1.0000 XPR", "shield:zz"]).send("alice@active"), "eosio_assert: memo must carry two 32-byte hex values");
await token.actions.transfer(["eosio.token", "relay", "10.0000 XPR", "seed"]).send("eosio.token@active");
await expectToThrow(token.actions.transfer(["relay", "xprshield", "1.0000 XPR", `shield:${hex(1n)}:${hex(2n)}`]).send("relay@active"), "eosio_assert: depositor has not registered a key");
lap("two deposits: commitments and root match the library; bad memos refused");

// --- alice → bob 1,234 XPR, submitted by `relay` ---
const prove = async (js) => {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(js.input, WASM, ZKEY);
  return { proof: encodeProof(proof), publics: encodeInputs(publicSignals), publicSignals };
};
const AMOUNT = units(1234);
const js = N.buildJoinSplit({ keys: alice, tree: local, auditorPk: auditor.pk, inputs: [{ note: a1, index: i1 }, { note: a2, index: i2 }], outputs: [{ pk: bob.pk, v: AMOUNT }, { pk: alice.pk, v: a1.v + a2.v - AMOUNT }] });
const p1 = await prove(js);
assert.deepEqual(p1.publicSignals.map(BigInt), N.publicSignals(js.expected, { root: local.root, A: auditor.pk }));
await sh.actions.transfer([p1.proof, p1.publics]).send("relay@active");
local.append(js.outNotes[0].cm); local.append(js.outNotes[1].cm);
assert.equal(treeRow().root, hex(local.root), "root after the transfer matches");
assert.equal(nullifiers().length, 2, "two nullifiers recorded");
assert.deepEqual(leaves().slice(-2).map((l) => l.cm), [hex(js.outNotes[0].cm), hex(js.outNotes[1].cm)]);
const bobNote = N.tryDecryptReceiver(bob, js.expected.epk[0], js.expected.cr[0], js.outNotes[0].cm);
assert.ok(bobNote && bobNote.v === AMOUNT, "bob finds his note by trial decryption");
const aud = N.decryptAuditor(auditor.ask, js.expected.epk[0], js.expected.ca[0], js.outNotes[0].cm);
assert.ok(aud.valid && aud.sender[0] === alice.pk[0] && aud.pk[0] === bob.pk[0], "auditor names both keys");
lap("relay submitted alice → bob 1,234 XPR: no party in the action; bob and the auditor read it");

// --- refusals ---
await expectToThrow(sh.actions.transfer([p1.proof, p1.publics]).send("relay@active"), "eosio_assert: note already spent");
const tampered = p1.publics.slice(0, 2 * 32 * 2) + hex(12345n) + p1.publics.slice(2 * 32 * 2 + 64);
await expectToThrow(sh.actions.transfer([p1.proof, tampered]).send("relay@active"), "eosio_assert: invalid proof");
const jsWrongAud = N.buildJoinSplit({ keys: bob, tree: local, auditorPk: N.keygen().pk, inputs: [{ note: bobNote, index: 4 }], outputs: [{ pk: alice.pk, v: 1n }, { pk: bob.pk, v: AMOUNT - 1n }] });
const pWrong = await prove(jsWrongAud);
await expectToThrow(sh.actions.transfer([pWrong.proof, pWrong.publics]).send("relay@active"), "eosio_assert: proof is not for the current auditor key");
lap("double spend, tampered publics and a foreign auditor key refused");

// --- a proof built before another deposit still verifies (root ring) ---
const bobChange = js.outNotes[0];
const jsOld = N.buildJoinSplit({ keys: bob, tree: local, auditorPk: auditor.pk, inputs: [{ note: bobChange, index: 4 }], outputs: [{ pk: alice.pk, v: units(34) }, { pk: bob.pk, v: AMOUNT - units(34) }] });
const pOld = await prove(jsOld);
const a3 = N.newNote(alice.pk, units(1), N.TOKENS.XPR);
await dep(a3);
await sh.actions.transfer([pOld.proof, pOld.publics]).send("relay@active");
local.append(jsOld.outNotes[0].cm); local.append(jsOld.outNotes[1].cm);
assert.equal(treeRow().root, hex(local.root));
lap("a proof against the previous root was accepted after a new deposit");

// --- bob withdraws 1,000 XPR to his public account ---
const bobNote2 = jsOld.outNotes[1]; const bobIdx2 = local.size - 1;
const jw = N.buildJoinSplit({ keys: bob, tree: local, auditorPk: auditor.pk, inputs: [{ note: bobNote2, index: bobIdx2 }], outputs: [{ pk: bob.pk, v: 0n }, { pk: bob.pk, v: bobNote2.v - units(1000) }], vPub: units(1000), tokenPub: N.TOKENS.XPR, to: N.nameToU64("bob") });
const pw = await prove(jw);
const redirected = pw.publics.slice(0, 35 * 64) + hex(N.nameToU64("relay")) + pw.publics.slice(36 * 64);
await expectToThrow(sh.actions.transfer([pw.proof, redirected]).send("relay@active"), "eosio_assert: invalid proof");
await sh.actions.transfer([pw.proof, pw.publics]).send("relay@active");
assert.equal(balance("bob"), "1000.0000 XPR", "bob received the withdrawal");
const tok = sh.tables.tokens(scope).getTableRows()[0];
assert.equal(BigInt(tok.pool), units(5000) + units(700) + units(1) - units(1000));
lap(`bob withdrew 1,000 XPR: public balance ${balance("bob")}; pool ${tok.pool}`);

// --- pause ---
await sh.actions.pause([true]).send("xprshield@active");
await expectToThrow(sh.actions.transfer([pw.proof, pw.publics]).send("relay@active"), "eosio_assert: paused");
lap("paused: transfers refused");
console.log("S3 xprshield passed");
process.exit(0);
