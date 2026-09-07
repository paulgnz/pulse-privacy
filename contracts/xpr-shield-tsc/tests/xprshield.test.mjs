// S8 end to end under vert: eosio.token + xprshield with real join-split proofs, signed sender.
//   init, addtoken, register → alice deposits 5,000 and 700 XPR (tree matches the library)
//   → alice signs alice → bob 1,234 XPR (receiver and amount hidden) → bob finds his note
//   → double spend, tampered publics, foreign auditor key, wrong signer, another's proof,
//     substituted key, redirected withdrawal, unregistered sender, stale-but-known root, pause
//   → bob withdraws 1,000 XPR to his own account.
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
const words = (h) => (h.match(/.{64}/g) ?? []).map((w) => BigInt("0x" + w));

await N.init();
const alice = N.keygen(), bob = N.keygen(), auditor = N.keygen();
const ALICE = N.nameToU64("alice"), BOB = N.nameToU64("bob");

const bc = new Blockchain();
bc.createAccounts("alice", "bob", "carol");
const token = bc.createContract("eosio.token", join(HERE, "../node_modules/proton-tsc/external/eosio.token/eosio.token"));
const sh = bc.createContract("xprshield", join(HERE, "../assembly/target/xprshield.contract"));
for (let i = 0; i < 400 && !(sh.actions.spend && token.actions.transfer); i++) await new Promise((r) => setTimeout(r, 25));
assert.ok(sh.actions.spend, "xprshield did not load");
await token.actions.create(["eosio.token", "1000000000.0000 XPR"]).send("eosio.token@active");
await token.actions.issue(["eosio.token", "100000.0000 XPR", ""]).send("eosio.token@active");
await token.actions.transfer(["eosio.token", "alice", "10000.0000 XPR", "seed"]).send("eosio.token@active");
await token.actions.transfer(["eosio.token", "carol", "10.0000 XPR", "seed"]).send("eosio.token@active");
lap("chain ready");

const scope = nameToBigInt("xprshield");
const treeRow = () => sh.tables.tree(scope).getTableRow(0n);
const leaves = () => sh.tables.leaves(scope).getTableRows();
const nullifiers = () => sh.tables.nullifiers(scope).getTableRows();
const balance = (acct) => { const r = token.tables.accounts(nameToBigInt(acct)).getTableRows(); return r.length ? r[0].balance : "0.0000 XPR"; };

// --- init / addtoken / register ---
await sh.actions.init([ptHex(auditor.pk), encodeVk(VK)]).send("xprshield@active");
await sh.actions.addtoken(["4,XPR", "eosio.token", "1", "0", "0", "10000"]).send("xprshield@active");
await expectToThrow(sh.actions.addtoken(["6,XMD", "xmd.token", "1", "0", "0", "0"]).send("xprshield@active"), "eosio_assert: token id already used by another token");
await sh.actions.addtoken(["4,XPR", "eosio.token", "1", "0", "0", "10000"]).send("xprshield@active"); // same token again: allowed (updates caps)
await sh.actions.register(["alice", ptHex(alice.pk)]).send("alice@active");
await sh.actions.register(["bob", ptHex(bob.pk)]).send("bob@active");
await expectToThrow(sh.actions.register(["bob", ptHex(bob.pk)]).send("bob@active"), "eosio_assert: already registered");
await expectToThrow(sh.actions.register(["carol", hex(alice.pk[0]) + hex(alice.pk[1] + 1n)]).send("carol@active"), "eosio_assert: pubkey not on curve");
await expectToThrow(sh.actions.register(["carol", hex(0n) + hex(1n)]).send("carol@active"), "eosio_assert: pubkey is the identity or has low order");
await expectToThrow(sh.actions.register(["carol", hex(0n) + hex(N.F.p - 1n)]).send("carol@active"), "eosio_assert: pubkey is the identity or has low order");
const local = new N.Tree();
assert.equal(treeRow().root, hex(local.root), "empty root matches");
lap("init + register; empty root matches the library");

// --- deposits ---
const dep = async (note, who = "alice") => {
  await token.actions.transfer([who, "xprshield", `${(Number(note.v) / 1e4).toFixed(4)} XPR`, `shield:${hex(note.r)}`]).send(`${who}@active`);
  await sh.actions.deposit([who, hex(note.r)]).send(`${who}@active`);
  const index = local.append(note.cm); local.append(0n);
  return index;
};
const a1 = N.newNote(alice.pk, units(5000), N.TOKENS.XPR);
const a2 = N.newNote(alice.pk, units(700), N.TOKENS.XPR);
const i1 = await dep(a1);
const i2 = await dep(a2);
assert.deepEqual(leaves().map((l) => [Number(l.index), l.cm]), [[0, hex(a1.cm)], [2, hex(a2.cm)]]);
assert.equal(treeRow().root, hex(local.root), "root after two deposits matches");
await expectToThrow(token.actions.transfer(["alice", "xprshield", "1.0000 XPR", "shield:zz"]).send("alice@active"), "eosio_assert: memo must carry one 32-byte hex value");
await expectToThrow(token.actions.transfer(["carol", "xprshield", "1.0000 XPR", `shield:${hex(2n)}`]).send("carol@active"), "eosio_assert: depositor has not registered a key");
await expectToThrow(token.actions.transfer(["alice", "xprshield", "0.5000 XPR", `shield:${hex(3n)}`]).send("alice@active"), "eosio_assert: deposit below the minimum");
await expectToThrow(token.actions.transfer(["alice", "xprshield", "1.0000 XPR", "not a deposit"]).send("alice@active"), "eosio_assert: memo must be shield:<r>");
// an arrived deposit waits as a credit until the owner's own action places it (owner pays the rows)
const a4 = N.newNote(alice.pk, units(2), N.TOKENS.XPR);
await token.actions.transfer(["alice", "xprshield", "2.0000 XPR", `shield:${hex(a4.r)}`]).send("alice@active");
assert.equal(sh.tables.credits(scope).getTableRows().length, 1, "credit recorded");
await expectToThrow(sh.actions.deposit(["bob", hex(a4.r)]).send("bob@active"), "eosio_assert: no arrived deposit with this r for this owner");
await expectToThrow(sh.actions.deposit(["alice", hex(a4.r + 1n)]).send("alice@active"), "eosio_assert: no arrived deposit with this r for this owner");
await sh.actions.deposit(["alice", hex(a4.r)]).send("alice@active");
assert.equal(sh.tables.credits(scope).getTableRows().length, 0, "credit consumed");
local.append(a4.cm); local.append(0n);
assert.equal(treeRow().root, hex(local.root), "root after the late deposit matches");
await expectToThrow(sh.actions.deposit(["alice", hex(a4.r)]).send("alice@active"), "eosio_assert: no arrived deposit with this r for this owner");
lap("deposits: commitments and root match the library; the owner's action places them; bad memos refused");

// --- alice → bob 1,234 XPR, signed by alice ---
const seq = () => Number(treeRow().root_seq);
const prove = async (js, pub = {}) => {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(js.input, WASM, ZKEY);
  return { proof: encodeProof(proof), publics: encodeInputs(N.actionPublics(js.expected)), publicSignals, amount: (pub.vPub ?? 0n).toString(), token: Number(pub.tokenPub ?? 0n), seq: pub.seq ?? seq() };
};
const spend = (who, p, over = {}) => sh.actions.spend([who, p.proof, p.publics, over.amount ?? p.amount, over.token ?? p.token, over.seq ?? p.seq]);
const AMOUNT = units(1234);
const js = N.buildJoinSplit({ keys: alice, tree: local, auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: a1, index: i1 }, { note: a2, index: i2 }], outputs: [{ pk: bob.pk, v: AMOUNT }, { pk: alice.pk, v: a1.v + a2.v - AMOUNT }] });
const bobLeaf = local.size; // the transfer's first output lands here
const p1 = await prove(js);
assert.deepEqual(p1.publicSignals.map(BigInt), N.publicSignals(js.expected, { root: local.root, sender: ALICE, A: auditor.pk }));
assert.equal(p1.publics.length / 64, 16, "the action carries 16 words");
// wrong signer for the named sender
await expectToThrow(spend("alice", p1).send("bob@active"), "missing required authority alice");
// someone else naming themselves as sender on alice's proof
await expectToThrow(spend("bob", p1).send("bob@active"), "eosio_assert: invalid proof");
// a token id on a plain transfer
await expectToThrow(spend("alice", p1, { token: 1 }).send("alice@active"), "eosio_assert: token_id only with a withdrawal");
// a root sequence the proof was not built against
await expectToThrow(spend("alice", p1, { seq: 1 }).send("alice@active"), "eosio_assert: invalid proof");
await expectToThrow(spend("alice", p1, { seq: 999 }).send("alice@active"), "eosio_assert: unknown or stale root");
// the sender's own signature
await spend("alice", p1).send("alice@active");
local.append(js.outNotes[0].cm); local.append(js.outNotes[1].cm);
assert.equal(treeRow().root, hex(local.root), "root after the transfer matches");
assert.equal(nullifiers().length, 2, "two nullifiers recorded");
const outs = sh.tables.outputs(scope).getTableRows();
const row4 = outs.find((o) => Number(o.index) === bobLeaf);
assert.equal(row4.epk.length, 64, "ephemeral key stored compressed");
assert.equal(row4.cr.length, 2 * 64, "receiver ciphertext is two words");
assert.equal(row4.ca.length, 3 * 64, "auditor ciphertext is three words");
const epk4 = N.decompressPoint(words(row4.epk)[0]);
const bobNote = N.tryDecryptReceiver(bob, epk4, words(row4.cr), js.outNotes[0].cm);
assert.ok(bobNote && bobNote.v === AMOUNT && bobNote.token === N.TOKENS.XPR, "bob finds his note from the chain alone");
const aud = N.decryptAuditor(auditor.ask, epk4, words(row4.ca), js.outNotes[0].cm);
assert.ok(aud.valid && aud.v === AMOUNT && aud.pk[0] === bob.pk[0] && aud.pk[1] === bob.pk[1], "auditor recovers the receiver key and amount; the action names alice");
assert.deepEqual(words(outs[0].cr), [N.pack(a1.v, N.TOKENS.XPR), a1.r], "deposit row carries the packed plaintext note");
lap("alice signed alice → bob 1,234 XPR: receiver and amount hidden; bob and the auditor read it; wrong signers refused");

// --- refusals ---
await expectToThrow(spend("alice", p1).send("alice@active"), "eosio_assert: note already spent");
const tampered = p1.publics.slice(0, 2 * 64) + hex(12345n) + p1.publics.slice(3 * 64);
await expectToThrow(sh.actions.spend(["alice", p1.proof, tampered, "0", 0, p1.seq]).send("alice@active"), "eosio_assert: invalid proof");
// a proof built with bob's key but signed and named by alice: the contract inserts alice's registered key
const jsKey = N.buildJoinSplit({ keys: bob, tree: local, auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: bobNote, index: bobLeaf }], outputs: [{ pk: alice.pk, v: 1n }, { pk: bob.pk, v: AMOUNT - 1n }] });
const pKey = await prove(jsKey);
await expectToThrow(spend("alice", pKey).send("alice@active"), "eosio_assert: invalid proof");
// a proof for a different auditor key than the contract's
const jsAud = N.buildJoinSplit({ keys: bob, tree: local, auditorPk: N.keygen().pk, sender: BOB, inputs: [{ note: bobNote, index: bobLeaf }], outputs: [{ pk: alice.pk, v: 1n }, { pk: bob.pk, v: AMOUNT - 1n }] });
const pAud = await prove(jsAud);
await expectToThrow(spend("bob", pAud).send("bob@active"), "eosio_assert: invalid proof");
// unregistered sender
await expectToThrow(spend("carol", p1).send("carol@active"), "eosio_assert: owner has not registered a shielded key");
lap("double spend, tampered publics, another's key, foreign auditor key and an unregistered sender refused");

// --- a proof built before another deposit still verifies (root ring) ---
const jsOld = N.buildJoinSplit({ keys: bob, tree: local, auditorPk: auditor.pk, sender: BOB, inputs: [{ note: bobNote, index: bobLeaf }], outputs: [{ pk: alice.pk, v: units(34) }, { pk: bob.pk, v: AMOUNT - units(34) }] });
const pOld = await prove(jsOld);
await dep(N.newNote(alice.pk, units(1), N.TOKENS.XPR));
await spend("bob", pOld).send("bob@active");
local.append(jsOld.outNotes[0].cm); local.append(jsOld.outNotes[1].cm);
assert.equal(treeRow().root, hex(local.root));
lap("a proof against the previous root was accepted after a new deposit");

// --- withdrawals: only to the sender's own account ---
const bobNote2 = jsOld.outNotes[1]; const bobIdx2 = local.size - 1;
const jwOther = N.buildJoinSplit({ keys: bob, tree: local, auditorPk: auditor.pk, sender: BOB, inputs: [{ note: bobNote2, index: bobIdx2 }], outputs: [{ pk: bob.pk, v: 0n }, { pk: bob.pk, v: bobNote2.v - units(1000) }], vPub: units(1000), tokenPub: N.TOKENS.XPR, to: ALICE });
const pwOther = await prove(jwOther, { vPub: units(1000), tokenPub: N.TOKENS.XPR });
await expectToThrow(spend("bob", pwOther).send("bob@active"), "eosio_assert: invalid proof");
const jw = N.buildJoinSplit({ keys: bob, tree: local, auditorPk: auditor.pk, sender: BOB, inputs: [{ note: bobNote2, index: bobIdx2 }], outputs: [{ pk: bob.pk, v: 0n }, { pk: bob.pk, v: bobNote2.v - units(1000) }], vPub: units(1000), tokenPub: N.TOKENS.XPR, to: BOB });
const pw = await prove(jw, { vPub: units(1000), tokenPub: N.TOKENS.XPR });
await expectToThrow(spend("bob", pw, { token: 2 }).send("bob@active"), "eosio_assert: invalid proof");
await expectToThrow(spend("bob", pw, { amount: "5000000" }).send("bob@active"), "eosio_assert: invalid proof");
await spend("bob", pw).send("bob@active");
assert.equal(balance("bob"), "1000.0000 XPR", "bob received the withdrawal");
const tok = sh.tables.tokens(scope).getTableRows()[0];
assert.equal(BigInt(tok.pool), units(5000) + units(700) + units(2) + units(1) - units(1000));
lap(`bob withdrew 1,000 XPR to himself: public balance ${balance("bob")}; pool ${tok.pool}`);

// --- pause ---
await sh.actions.pause([true]).send("xprshield@active");
await expectToThrow(spend("bob", pw).send("bob@active"), "eosio_assert: paused");
lap("paused: transfers refused");
// committee restore while paused
await expectToThrow(sh.actions.restore(["alice", "1.0000 XPR", "lost key"]).send("bob@active"), "missing required authority xprshield");
await sh.actions.restore(["alice", "1.0000 XPR", "lost key"]).send("xprshield@active");
assert.equal(balance("alice"), "4298.0000 XPR", "alice received the restore");
await sh.actions.pause([false]).send("xprshield@active");
await expectToThrow(sh.actions.restore(["alice", "1.0000 XPR", "x"]).send("xprshield@active"), "eosio_assert: restore is only possible while paused");
await sh.actions.pause([true]).send("xprshield@active");
lap("restore: paused only, contract authority, paid from escrow");

// --- testnet reset wipes everything and allows a fresh init ---
await expectToThrow(sh.actions.reset([]).send("bob@active"), "missing required authority xprshield");
await sh.actions.reset([]).send("xprshield@active");
assert.equal(leaves().length, 0); assert.equal(nullifiers().length, 0); assert.equal(sh.tables.keys(scope).getTableRows().length, 0);
await sh.actions.init([ptHex(auditor.pk), encodeVk(VK)]).send("xprshield@active");
assert.equal(treeRow().root, hex(new N.Tree().root), "fresh tree after reset");
lap("reset: tables wiped, re-initialised");
console.log("xprshield (revision 4) passed");
process.exit(0);
