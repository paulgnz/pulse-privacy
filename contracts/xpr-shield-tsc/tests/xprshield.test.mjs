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
bc.createAccounts("alice", "bob", "carol", "frank");
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
const leaves = () => sh.tables.outputs(scope).getTableRows().map((o) => ({ index: o.index, cm: o.cm }));
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
await expectToThrow(sh.actions.register(["carol", ptHex(alice.pk)]).send("carol@active"), "eosio_assert: this key is already registered by another account");
assert.equal(sh.tables.credits(scope).getTableRows().length, 2, "register created one owner-paid deposit slot per account");
await expectToThrow(sh.actions.open(["carol"]).send("carol@active"), "eosio_assert: register a key first");
await sh.actions.open(["alice"]).send("alice@active"); // idempotent
assert.equal(sh.tables.credits(scope).getTableRows().length, 2);
// --- backups: phrase copy 60..160 bytes, committee copy exactly 64, empties clear the row ---
{
  const phrase = "ab".repeat(96), committee = "cd".repeat(64);
  await sh.actions.setbackup(["alice", phrase, committee]).send("alice@active");
  let row = sh.tables.backups(nameToBigInt("xprshield")).getTableRow(nameToBigInt("alice"));
  assert.equal(row.phrase, phrase); assert.equal(row.committee, committee);
  const committee2 = "ef".repeat(64);
  await sh.actions.setbackup(["alice", "", committee2]).send("alice@active"); // empty keeps the phrase
  row = sh.tables.backups(nameToBigInt("xprshield")).getTableRow(nameToBigInt("alice"));
  assert.equal(row.phrase, phrase); assert.equal(row.committee, committee2);
  await sh.actions.clearbackup(["alice", true, false]).send("alice@active");
  row = sh.tables.backups(nameToBigInt("xprshield")).getTableRow(nameToBigInt("alice"));
  assert.equal(row.phrase, ""); assert.equal(row.committee, committee2);
  await expectToThrow(sh.actions.setbackup(["alice", "ab".repeat(10), ""]).send("alice@active"), "eosio_assert: phrase copy must be 60 to 160 bytes");
  await expectToThrow(sh.actions.setbackup(["alice", "", "cd".repeat(63)]).send("alice@active"), "eosio_assert: committee copy must be 64 bytes");
  await expectToThrow(sh.actions.setbackup(["alice", phrase, ""]).send("bob@active"), "missing required authority alice");
  await expectToThrow(sh.actions.setbackup(["alice", "", ""]).send("alice@active"), "eosio_assert: nothing to store");
  await sh.actions.clearbackup(["alice", false, true]).send("alice@active");
  assert.equal(sh.tables.backups(nameToBigInt("xprshield")).getTableRow(nameToBigInt("alice")), undefined);
  console.log("ok  backups: store, replace one copy keeping the other, refuse bad sizes, clear");
}
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
assert.equal(sh.tables.credits(scope).getTableRows().every((c) => String(c.amount) === "0"), true, "slots empty after placed deposits");
await expectToThrow(token.actions.transfer(["alice", "xprshield", "0.5000 XPR", `shield:${hex(3n)}`]).send("alice@active"), "eosio_assert: deposit below the minimum");
await expectToThrow(token.actions.transfer(["alice", "xprshield", "1.0000 XPR", "not a deposit"]).send("alice@active"), "eosio_assert: memo must be shield:<r>");
// an arrived deposit waits as a credit until the owner's own action places it (owner pays the rows)
const a4 = N.newNote(alice.pk, units(2), N.TOKENS.XPR);
await token.actions.transfer(["alice", "xprshield", "2.0000 XPR", `shield:${hex(a4.r)}`]).send("alice@active");
const slotOf = (who) => sh.tables.credits(scope).getTableRow(nameToBigInt(who));
assert.equal(String(slotOf("alice").amount), String(units(2)), "the arrival filled alice's slot");
assert.equal(slotOf("alice").owner, "alice");
// an occupied slot refuses the next arrival: the transaction fails and the tokens never leave alice
await expectToThrow(token.actions.transfer(["alice", "xprshield", "3.0000 XPR", `shield:${hex(a4.r + 7n)}`]).send("alice@active"), "eosio_assert: finish your pending deposit first");
await expectToThrow(sh.actions.deposit(["bob", hex(a4.r)]).send("bob@active"), "eosio_assert: no arrived deposit for this owner");
await expectToThrow(sh.actions.deposit(["alice", hex(a4.r + 1n)]).send("alice@active"), "eosio_assert: r does not match the arrived deposit");
await sh.actions.deposit(["alice", hex(a4.r)]).send("alice@active");
assert.equal(String(slotOf("alice").amount), "0", "slot emptied");
assert.equal(slotOf("alice").r, "00".repeat(32));
const i4 = local.size; local.append(a4.cm); local.append(0n);
assert.equal(treeRow().root, hex(local.root), "root after the late deposit matches");
await expectToThrow(sh.actions.deposit(["alice", hex(a4.r)]).send("alice@active"), "eosio_assert: no arrived deposit for this owner");
lap("deposits: commitments and root match the library; the owner's slot takes one arrival at a time; bad memos refused");

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
assert.equal(outs[0].cm, hex(a1.cm), "the output row carries the commitment (no separate leaves table)");
lap("alice signed alice → bob 1,234 XPR: receiver and amount hidden; bob and the auditor read it; wrong signers refused");

// --- refusals ---
await expectToThrow(spend("alice", p1).send("alice@active"), "eosio_assert: note already spent");
const tampered = p1.publics.slice(0, 2 * 64) + hex(12345n) + p1.publics.slice(3 * 64);
await expectToThrow(sh.actions.spend(["alice", p1.proof, tampered, "0", 0, p1.seq]).send("alice@active"), "eosio_assert: invalid proof");
// bit-flip fuzz: p1 is a valid proof whose notes are now spent, so a flipped copy that somehow
// verified would fail on "already spent"; every other outcome must be a refusal, never success
{
  const FLIPS = Number(process.env.FLIPS ?? 40);
  const flip = (hexStr, bit) => { const bytes = Buffer.from(hexStr, "hex"); bytes[bit >> 3] ^= 1 << (bit & 7); return bytes.toString("hex"); };
  let refused = 0;
  const reasons = new Map();
  for (let i = 0; i < FLIPS; i++) {
    const inProof = i % 2 === 0;
    const target = inProof ? p1.proof : p1.publics;
    const bit = Math.floor(Math.random() * target.length * 4);
    const args = inProof ? ["alice", flip(p1.proof, bit), p1.publics, "0", 0, p1.seq] : ["alice", p1.proof, flip(p1.publics, bit), "0", 0, p1.seq];
    try { await sh.actions.spend(args).send("alice@active"); assert.fail(`flipped bit ${bit} in ${inProof ? "proof" : "publics"} was accepted`); }
    catch (e) { if (/was accepted/.test(e.message)) throw e; refused++; const r = String(e.message).replace(/^.*eosio_assert: /, "").slice(0, 40); reasons.set(r, (reasons.get(r) ?? 0) + 1); }
  }
  assert.equal(refused, FLIPS);
  lap(`bit-flip fuzz: ${FLIPS} corrupted proofs/publics all refused (${[...reasons].map(([r, n]) => `${r}: ${n}`).join("; ")})`);
}
// a proof built with bob's key but signed and named by alice: the contract inserts alice's registered key
const jsKey = N.buildJoinSplit({ keys: bob, tree: local, auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: bobNote, index: bobLeaf }], outputs: [{ pk: alice.pk, v: 1n }, { pk: bob.pk, v: AMOUNT - 1n }] });
const pKey = await prove(jsKey);
await expectToThrow(spend("alice", pKey).send("alice@active"), "eosio_assert: invalid proof");
// esk a multiple of the subgroup order: the circuit only forbids esk = 0, so epk would be the
// identity and both ciphertexts readable by anyone; the contract refuses the low-order key
const jsEsk = N.buildJoinSplit({ keys: bob, tree: local, auditorPk: auditor.pk, sender: BOB, inputs: [{ note: bobNote, index: bobLeaf }], outputs: [{ pk: alice.pk, v: 1n, esk: N.bj.subOrder }, { pk: bob.pk, v: AMOUNT - 1n }] });
assert.deepEqual(jsEsk.expected.epk[0], [0n, 1n], "esk = L gives the identity in the library");
// revision 5 bounds esk below L in the circuit, so no proof exists; the contract's own check stays as a second line
await assert.rejects(prove(jsEsk), /Assert Failed/, "the circuit refuses esk = L");
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
await expectToThrow(spend("bob", pw).send("bob@active"), "eosio_assert: open a balance for this token in your wallet first"); // bob never held XPR
await token.actions.open(["bob", "4,XPR", "bob"]).send("bob@active");
await spend("bob", pw).send("bob@active");
assert.equal(balance("bob"), "1000.0000 XPR", "bob received the withdrawal");
const tok = sh.tables.tokens(scope).getTableRows()[0];
assert.equal(BigInt(tok.pool), units(5000) + units(700) + units(2) + units(1) - units(1000));
lap(`bob withdrew 1,000 XPR to himself: public balance ${balance("bob")}; pool ${tok.pool}`);
// frank has never held XPR: a withdrawal would make the token contract bill his balance row to
// xprshield, so it is refused until he opens one
const frank = N.keygen(), FRANK = N.nameToU64("frank");
await sh.actions.register(["frank", ptHex(frank.pk)]).send("frank@active");
local.append(jw.outNotes[0].cm); local.append(jw.outNotes[1].cm); // bob's withdrawal outputs
const bobNote3 = jw.outNotes[1]; const bobIdx3 = local.size - 1;
const jsToFrank = N.buildJoinSplit({ keys: bob, tree: local, auditorPk: auditor.pk, sender: BOB, inputs: [{ note: bobNote3, index: bobIdx3 }], outputs: [{ pk: frank.pk, v: units(5) }, { pk: bob.pk, v: bobNote3.v - units(5) }] });
const pToFrank = await prove(jsToFrank);
await spend("bob", pToFrank).send("bob@active");
local.append(jsToFrank.outNotes[0].cm); local.append(jsToFrank.outNotes[1].cm);
const frankNote = jsToFrank.outNotes[0]; const frankIdx = local.size - 2;
const jwFrank = N.buildJoinSplit({ keys: frank, tree: local, auditorPk: auditor.pk, sender: FRANK, inputs: [{ note: frankNote, index: frankIdx }], outputs: [{ pk: frank.pk, v: 0n }, { pk: frank.pk, v: 0n }], vPub: units(5), tokenPub: N.TOKENS.XPR, to: FRANK });
const pwFrank = await prove(jwFrank, { vPub: units(5), tokenPub: N.TOKENS.XPR });
await expectToThrow(spend("frank", pwFrank).send("frank@active"), "eosio_assert: open a balance for this token in your wallet first");
await token.actions.open(["frank", "4,XPR", "frank"]).send("frank@active");
await spend("frank", pwFrank).send("frank@active");
local.append(jwFrank.outNotes[0].cm); local.append(jwFrank.outNotes[1].cm);
assert.equal(balance("frank"), "5.0000 XPR", "frank received the withdrawal once he held a balance row");
lap("a withdrawal to an account with no balance row is refused; after open it pays");

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
// a restored account is marked and can no longer spend, even with its key, until the committee lifts the mark
await sh.actions.pause([false]).send("xprshield@active");
assert.equal(String(sh.tables.restored(scope).getTableRow(nameToBigInt("alice")).amount), String(units(1)), "restore recorded the returned amount");
const jsRestored = N.buildJoinSplit({ keys: alice, tree: local, auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: a4, index: i4 }], outputs: [{ pk: bob.pk, v: units(1) }, { pk: alice.pk, v: a4.v - units(1) }] });
const pRestored = await prove(jsRestored);
await expectToThrow(spend("alice", pRestored).send("alice@active"), "eosio_assert: this account's balance was returned by the committee; contact the operator");
await expectToThrow(sh.actions.unrestore(["alice", "funds returned"]).send("alice@active"), "missing required authority xprshield");
await sh.actions.unrestore(["alice", "funds returned"]).send("xprshield@active");
await spend("alice", pRestored).send("alice@active");
local.append(jsRestored.outNotes[0].cm); local.append(jsRestored.outNotes[1].cm);
await sh.actions.pause([true]).send("xprshield@active");
lap("a restored account cannot spend until the committee lifts the mark");

// --- rollover: a second tree; its notes carry global indices and prove against its own root ---
await sh.actions.pause([false]).send("xprshield@active");
await sh.actions.newtree([]).send("xprshield@active");
assert.equal(Number(sh.tables.config(scope).getTableRows()[0].active_tree), 1, "tree 1 is active");
const local1 = new N.Tree(20, 1);
const aT = N.newNote(alice.pk, units(3), N.TOKENS.XPR);
await token.actions.transfer(["alice", "xprshield", "3.0000 XPR", `shield:${hex(aT.r)}`]).send("alice@active");
await sh.actions.deposit(["alice", hex(aT.r)]).send("alice@active");
const gT = local1.append(aT.cm); local1.append(0n);
assert.equal(gT, 2 ** 20, "the first leaf of tree 1 has global index 2^20");
// a second deposit, so the first note's Merkle path has a non-zero sibling above the leaf level
const aT2 = N.newNote(alice.pk, units(4), N.TOKENS.XPR);
await token.actions.transfer(["alice", "xprshield", "4.0000 XPR", `shield:${hex(aT2.r)}`]).send("alice@active");
await sh.actions.deposit(["alice", hex(aT2.r)]).send("alice@active");
local1.append(aT2.cm); local1.append(0n);
const row1 = sh.tables.tree(scope).getTableRow(1n);
assert.equal(row1.root, hex(local1.root), "tree 1 root matches the library");
assert.notEqual(local1.path(gT).siblings[1], 0n, "the path of the first note has a real sibling at level 1");
assert.ok(sh.tables.outputs(scope).getTableRows().some((o) => Number(o.index) === gT), "the output row is keyed by the global index");
assert.notEqual(hex(N.nullifier(alice.nk, gT)), hex(N.nullifier(alice.nk, 0)), "same position, different tree, different nullifier");
const jsT = N.buildJoinSplit({ keys: alice, tree: local1, auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: aT, index: gT }], outputs: [{ pk: bob.pk, v: units(1) }, { pk: alice.pk, v: units(2) }] });
const pT = await prove(jsT, { seq: Number(row1.root_seq) });
await expectToThrow(spend("alice", pT, { seq: seq() }).send("alice@active"), "eosio_assert: invalid proof"); // tree 0's root and tree word
await spend("alice", pT).send("alice@active");
local1.append(jsT.outNotes[0].cm); local1.append(jsT.outNotes[1].cm);
assert.equal(sh.tables.tree(scope).getTableRow(1n).root, hex(local1.root), "tree 1 root after the spend matches");
assert.throws(() => N.buildJoinSplit({ keys: alice, tree: local1, auditorPk: auditor.pk, sender: ALICE, inputs: [{ note: aT, index: gT }, { note: a4, index: i4 }], outputs: [{ pk: bob.pk, v: 1n }, { pk: alice.pk, v: aT.v + a4.v - 1n }] }), /not in tree 1/, "inputs must share one tree");
lap("rollover: newtree, a deposit and a payment in tree 1 (global indices), tree 0 root refused for it, inputs cannot span trees");
await sh.actions.pause([true]).send("xprshield@active");


// --- testnet reset wipes everything and allows a fresh init ---
await expectToThrow(sh.actions.reset([]).send("bob@active"), "missing required authority xprshield");
await sh.actions.reset([]).send("xprshield@active");
assert.equal(sh.tables.outputs(scope).getTableRows().length, 0); assert.equal(nullifiers().length, 0); assert.equal(sh.tables.keys(scope).getTableRows().length, 0);
await sh.actions.init([ptHex(auditor.pk), encodeVk(VK)]).send("xprshield@active");
assert.equal(treeRow().root, hex(new N.Tree().root), "fresh tree after reset");
lap("reset: tables wiped, re-initialised");
console.log("xprshield (revision 6) passed");
process.exit(0);
