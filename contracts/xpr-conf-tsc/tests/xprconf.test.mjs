// T3 end-to-end under vert: eosio.token + xprconf, real circuit proofs.
//   register alice/bob → alice deposits 5,000 XPR → fold → alice sends 1,234 to bob (proof)
//   → bob reads +1,234 → auditor reads 1,234 → bob folds → bob withdraws 1,000 (proof)
//   → bob's public balance is 1,000 → granularity / overdraft / replay rejections
// Needs circuits/build (compile + setup) for the wasm, zkey and vk.
import { Blockchain, expectToThrow, nameToBigInt } from "@proton/vert";
import * as snarkjs from "snarkjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import eg from "../../../circuits/lib/elgamal.mjs";
import { encodeProof, encodeVk } from "../../../circuits/lib/encode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CB = (p) => join(HERE, "../../../circuits/build", p);
const WASM = CB("transfer_js/transfer.wasm");
const ZKEY = CB("transfer_final.zkey");
const VK = JSON.parse(readFileSync(CB("transfer_vk.json"), "utf8"));
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const XPR = (n) => `${(Number(n) / 1e4).toFixed(4)} XPR`;
const units = (xpr) => BigInt(Math.round(xpr * 1e4));

await eg.init();
const alice = eg.keygen();
const bob = eg.keygen();
const auditor = eg.keygen();

// --- chain ---
const bc = new Blockchain();
const [aliceAcc, bobAcc] = bc.createAccounts("alice", "bob");
const token = bc.createContract("eosio.token", join(HERE, "../node_modules/proton-tsc/external/eosio.token/eosio.token"));
const conf = bc.createContract("xprconf", join(HERE, "../assembly/target/xprconf.contract"));
for (let i = 0; i < 400 && !(conf.actions.send && token.actions.transfer); i++) await new Promise((r) => setTimeout(r, 25));
if (!conf.actions.send) throw new Error("xprconf did not load");
await token.actions.create(["eosio.token", "1000000000.0000 XPR"]).send("eosio.token@active");
await token.actions.issue(["eosio.token", "100000.0000 XPR", ""]).send("eosio.token@active");
await token.actions.transfer(["eosio.token", "alice", "10000.0000 XPR", "seed"]).send("eosio.token@active");
lap("chain ready: eosio.token + xprconf, alice has 10,000 XPR");

// --- init: vk from the rehearsal ceremony, auditor key, whole-XPR granularity on withdraw ---
await conf.actions.init(["4,XPR", "eosio.token", eg.ptHex(auditor.P), encodeVk(VK), "10000", "0"]).send("xprconf@active");
await conf.actions.register(["alice", "4,XPR", eg.ptHex(alice.P)]).send("alice@active");
await conf.actions.register(["bob", "4,XPR", eg.ptHex(bob.P)]).send("bob@active");
await expectToThrow(conf.actions.register(["alice", "4,XPR", eg.ptHex(alice.P)]).send("alice@active"), "eosio_assert: already registered");
const regRow = conf.tables.accounts(symScope()).getTableRow(nameToBigInt("alice"));
if (regRow.enc_pubkey.length !== 64 || eg.toObj(eg.decompressHex(regRow.enc_pubkey))[0] !== eg.toObj(alice.P)[0]) throw new Error("stored pubkey is not the 32-byte compressed form");
lap("init + register (keys stored compressed, 32 B)");

// accounts are scoped by the symbol raw value (precision in the low byte, code above it)
function symScope() {
  const code = "XPR";
  let raw = 4n;
  for (let i = 0; i < code.length; i++) raw |= BigInt(code.charCodeAt(i)) << BigInt(8 * (i + 1));
  return raw;
}
const acct = (name) => conf.tables.accounts(symScope()).getTableRow(nameToBigInt(name));

// --- deposit 5,000 XPR (public), then fold ---
await token.actions.transfer(["alice", "xprconf", "5000.0000 XPR", "conf:alice"]).send("alice@active");
let a = acct("alice");
if (a.pending_count !== 1) throw new Error("deposit not credited");
await conf.actions.applypending(["alice", "4,XPR"]).send("alice@active");
a = acct("alice");
const aliceBal = eg.decrypt64(eg.ctFromHex(a.avail), alice.s);
if (aliceBal !== units(5000)) throw new Error(`alice avail decrypts to ${aliceBal}`);
lap(`deposit + fold: alice's avail decrypts to ${XPR(aliceBal)} (chain shows a box)`);

// --- alice → bob 1,234 XPR with a real proof ---
const bold = eg.ctFromHex(a.avail);
const voldChunks = [eg.bsgs32(eg.decryptPoint(bold[0].C, bold[0].D, alice.s)), eg.bsgs32(eg.decryptPoint(bold[1].C, bold[1].D, alice.s))];
const wit = eg.buildTransferWitness({
  sender: alice, receiverP: bob.P, auditorP: auditor.P, bold, voldChunks, v: units(1234),
  nonce: BigInt(a.nonce), senderName: nameToBigInt("alice"), receiverName: nameToBigInt("bob"),
});
let { proof } = await snarkjs.groth16.fullProve(wit.input, WASM, ZKEY);
lap("transfer proof generated");
const tHex = eg.tHex(wit.T);
const bnewHex = eg.ctHex(wit.Bnew);
await conf.actions.send(["alice", "4,XPR", "bob", eg.ptHex(alice.P), eg.ptHex(bob.P), eg.ptHex(auditor.P), tHex, bnewHex, encodeProof(proof)]).send("alice@active");
lap("send accepted on chain");

// replay is rejected (nonce and balance moved on)
await expectToThrow(conf.actions.send(["alice", "4,XPR", "bob", eg.ptHex(alice.P), eg.ptHex(bob.P), eg.ptHex(auditor.P), tHex, bnewHex, encodeProof(proof)]).send("alice@active"), "eosio_assert: invalid proof");
// a wrong key hint is rejected before any proof work
await expectToThrow(conf.actions.send(["alice", "4,XPR", "bob", eg.ptHex(bob.P), eg.ptHex(bob.P), eg.ptHex(auditor.P), tHex, bnewHex, encodeProof(proof)]).send("alice@active"), "eosio_assert: ps does not match the sender's registered key");
lap("replay rejected");

a = acct("alice");
let b = acct("bob");
if (eg.decrypt64(eg.ctFromHex(a.avail), alice.s) !== units(5000 - 1234)) throw new Error("alice new balance wrong");
const bobPending = eg.decrypt64(eg.tReceiverFromHex(tHex), bob.s); // from the action data
const bobPendingOnChain = eg.decrypt64(eg.ctFromHex(b.pending), bob.s); // from the table
const auditorReads = eg.decrypt64(eg.tAuditorFromHex(tHex), auditor.s);
if (bobPending !== units(1234) || bobPendingOnChain !== units(1234) || auditorReads !== units(1234)) throw new Error("decrypt mismatch");
lap(`alice reads ${XPR(units(5000 - 1234))} · bob reads +${XPR(bobPending)} · auditor reads ${XPR(auditorReads)}`);

// --- bob folds and withdraws 1,000 XPR (public) ---
await conf.actions.applypending(["bob", "4,XPR"]).send("bob@active");
b = acct("bob");
const bBold = eg.ctFromHex(b.avail);
const bVold = [eg.bsgs32(eg.decryptPoint(bBold[0].C, bBold[0].D, bob.s)), eg.bsgs32(eg.decryptPoint(bBold[1].C, bBold[1].D, bob.s))];
const wwit = eg.buildWithdrawWitness({ owner: bob, auditorP: auditor.P, bold: bBold, voldChunks: bVold, v: units(1000), nonce: BigInt(b.nonce), ownerName: nameToBigInt("bob") });
({ proof } = await snarkjs.groth16.fullProve(wwit.input, WASM, ZKEY));
lap("withdraw proof generated");
await conf.actions.withdraw(["bob", "1000.0000 XPR", eg.ptHex(bob.P), eg.ptHex(auditor.P), eg.ctHex(wwit.Bnew), encodeProof(proof)]).send("bob@active");
const bobPublic = token.tables.accounts(nameToBigInt("bob")).getTableRows();
if (!bobPublic.some((r) => r.balance === "1000.0000 XPR")) throw new Error(`bob public balance: ${JSON.stringify(bobPublic)}`);
b = acct("bob");
if (eg.decrypt64(eg.ctFromHex(b.avail), bob.s) !== units(234)) throw new Error("bob confidential balance after withdraw wrong");
lap("withdraw: bob has 1,000.0000 XPR public and 234 XPR confidential");

// --- rejections ---
await expectToThrow(conf.actions.withdraw(["bob", "12.3456 XPR", eg.ptHex(bob.P), eg.ptHex(auditor.P), eg.ctHex(wwit.Bnew), encodeProof(proof)]).send("bob@active"), "eosio_assert: withdrawal must be a multiple of the granularity");
lap("granularity enforced (12.3456 XPR rejected)");
let overdraft = null;
try { eg.buildWithdrawWitness({ owner: bob, auditorP: auditor.P, bold: eg.ctFromHex(b.avail), voldChunks: [units(234), 0n], v: units(300), nonce: 1n, ownerName: 1n }); } catch (e) { overdraft = e.message; }
if (overdraft !== "insufficient balance") throw new Error("overdraft witness should fail");
lap("overdraft cannot be proven");
const escrow = token.tables.accounts(nameToBigInt("xprconf")).getTableRows();
lap(`escrow (public proof of reserve): ${escrow[0]?.balance}`);

// --- soft-launch limits ---
await conf.actions.setlimits(["4,XPR", (units(800)).toString(), (units(600)).toString()]).send("xprconf@active");
await expectToThrow(token.actions.transfer(["alice", "xprconf", "700.0000 XPR", "conf:alice"]).send("alice@active"), "eosio_assert: deposit above the current per-deposit limit");
await token.actions.transfer(["alice", "xprconf", "500.0000 XPR", "conf:alice"]).send("alice@active");
await expectToThrow(token.actions.transfer(["alice", "xprconf", "500.0000 XPR", "conf:alice"]).send("alice@active"), "eosio_assert: the pool is at its current limit; try a smaller deposit later");
const lim = conf.tables.limits(nameToBigInt("xprconf")).getTableRow(symScope());
if (String(lim.pool) !== String(units(500))) throw new Error(`pool counter ${lim.pool}`);
lap("soft-launch limits: per-deposit cap and pool cap enforced");

// --- register once, receive any token: XMD configured, bob only registered for XPR ---
await token.actions.create(["eosio.token", "1000000.000000 XMD"]).send("eosio.token@active");
await token.actions.issue(["eosio.token", "1000.000000 XMD", ""]).send("eosio.token@active");
await token.actions.transfer(["eosio.token", "alice", "100.000000 XMD", "seed"]).send("eosio.token@active");
await conf.actions.init(["6,XMD", "eosio.token", eg.ptHex(auditor.P), encodeVk(VK), "1000000", "0"]).send("xprconf@active");
await token.actions.transfer(["alice", "xprconf", "10.000000 XMD", "conf:alice"]).send("alice@active"); // alice auto-registered for XMD
await conf.actions.applypending(["alice", "6,XMD"]).send("alice@active");
function xmdScope() { let raw = 6n; for (let i = 0; i < 3; i++) raw |= BigInt("XMD".charCodeAt(i)) << BigInt(8 * (i + 1)); return raw; }
const ax = conf.tables.accounts(xmdScope()).getTableRow(nameToBigInt("alice"));
if (!ax || eg.decrypt64(eg.ctFromHex(ax.avail), alice.s) !== 10_000_000n) throw new Error("alice XMD auto-row / balance wrong");
const xbold = eg.ctFromHex(ax.avail);
const xvold = [eg.bsgs32(eg.decryptPoint(xbold[0].C, xbold[0].D, alice.s)), eg.bsgs32(eg.decryptPoint(xbold[1].C, xbold[1].D, alice.s))];
const xw = eg.buildTransferWitness({ sender: alice, receiverP: bob.P, auditorP: auditor.P, bold: xbold, voldChunks: xvold, v: 2_500_000n, nonce: BigInt(ax.nonce), senderName: nameToBigInt("alice"), receiverName: nameToBigInt("bob") });
const xp = await snarkjs.groth16.fullProve(xw.input, WASM, ZKEY);
await conf.actions.send(["alice", "6,XMD", "bob", eg.ptHex(alice.P), eg.ptHex(bob.P), eg.ptHex(auditor.P), eg.tHex(xw.T), eg.ctHex(xw.Bnew), encodeProof(xp.proof)]).send("alice@active");
const bx = conf.tables.accounts(xmdScope()).getTableRow(nameToBigInt("bob"));
if (!bx || eg.decrypt64(eg.ctFromHex(bx.pending), bob.s) !== 2_500_000n) throw new Error("bob did not receive XMD via auto-registration");
lap("register once, receive any token: alice auto-registered for XMD by deposit, bob by receiving 2.5 XMD");
// --- review findings: forged points must be rejected before proof verification ---
const ax2 = conf.tables.accounts(xmdScope()).getTableRow(nameToBigInt("alice"));
const b2 = eg.ctFromHex(ax2.avail);
const v2 = [eg.bsgs32(eg.decryptPoint(b2[0].C, b2[0].D, alice.s)), eg.bsgs32(eg.decryptPoint(b2[1].C, b2[1].D, alice.s))];
const gw = eg.buildTransferWitness({ sender: alice, receiverP: bob.P, auditorP: auditor.P, bold: b2, voldChunks: v2, v: 1_000_000n, nonce: BigInt(ax2.nonce), senderName: nameToBigInt("alice"), receiverName: nameToBigInt("bob") });
const gp = await snarkjs.groth16.fullProve(gw.input, WASM, ZKEY);
const tGood = eg.tHex(gw.T);
// an off-curve key with the same compressed form as bob's (same y, same sign of x)
const bobO = eg.toObj(bob.P);
const forgedP = eg.toPt([bobO[0] ^ 2n, bobO[1]]);
if (eg.compressHex(forgedP) !== eg.compressHex(bob.P)) throw new Error("forged key should compress like bob's");
await expectToThrow(
  conf.actions.send(["alice", "6,XMD", "bob", eg.ptHex(alice.P), eg.ptHex(forgedP), eg.ptHex(auditor.P), tGood, eg.ctHex(gw.Bnew), encodeProof(gp.proof)]).send("alice@active"),
  "eosio_assert: pr does not match the receiver's registered key"
);
lap("off-curve receiver key rejected (before the proof is looked at)");
// a non-canonical coordinate (word + p) reduces to the same scalar for the verifier but is not a point
const P_BJ = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const w0 = BigInt("0x" + tGood.slice(0, 64)) + P_BJ;
const tBad = w0.toString(16).padStart(64, "0") + tGood.slice(64);
await expectToThrow(
  conf.actions.send(["alice", "6,XMD", "bob", eg.ptHex(alice.P), eg.ptHex(bob.P), eg.ptHex(auditor.P), tBad, eg.ctHex(gw.Bnew), encodeProof(gp.proof)]).send("alice@active"),
  "eosio_assert: t contains a point that is not on the curve"
);
// and the untouched transaction still goes through
await conf.actions.send(["alice", "6,XMD", "bob", eg.ptHex(alice.P), eg.ptHex(bob.P), eg.ptHex(auditor.P), tGood, eg.ctHex(gw.Bnew), encodeProof(gp.proof)]).send("alice@active");
lap("non-canonical coordinate rejected; canonical send accepted");

// --- setpool corrects the counter ---
await conf.actions.setpool(["4,XPR", "123"]).send("xprconf@active");
if (String(conf.tables.limits(nameToBigInt("xprconf")).getTableRow(symScope()).pool) !== "123") throw new Error("setpool");
lap("setpool ok");
// --- recovery copy and committee restore ---
const blob = Array.from({ length: 96 }, (_, i) => i & 0xff);
await conf.actions.setrecovery(["bob", Buffer.from(blob).toString("hex")]).send("bob@active");
const rr = conf.tables.recovery(nameToBigInt("xprconf")).getTableRow(nameToBigInt("bob"));
if (!rr || rr.blob.length !== 192) throw new Error("recovery row");
await expectToThrow(conf.actions.setrecovery(["bob", "00"]).send("bob@active"), "eosio_assert: blob must be 96 bytes");
// restore only while paused, only by the contract
await expectToThrow(conf.actions.restore(["bob", "100.0000 XPR", "test"]).send("xprconf@active"), "eosio_assert: restore is only possible while the token is paused");
await conf.actions.configure(["4,XPR", eg.ptHex(auditor.P), "10000", "0", true]).send("xprconf@active");
await expectToThrow(conf.actions.restore(["bob", "100.0000 XPR", "test"]).send("bob@active"), "missing required authority xprconf");
const pubOf = (n) => BigInt(String(token.tables.accounts(nameToBigInt(n)).getTableRows().find((r) => String(r.balance).endsWith(" XPR"))?.balance ?? "0.0000 XPR").split(" ")[0].replace(".", ""));
const bobBefore = pubOf("bob");
await conf.actions.restore(["bob", "100.0000 XPR", "reconciliation 2026-09-07"]).send("xprconf@active");
const bobAfter = pubOf("bob");
if (bobAfter - bobBefore !== 1_000_000n) throw new Error(`restore paid ${bobAfter - bobBefore}`);
const bobRow = conf.tables.accounts(symScope()).getTableRow(nameToBigInt("bob"));
if (eg.decrypt64(eg.ctFromHex(bobRow.avail), bob.s) !== 0n || bobRow.pending_count !== 0) throw new Error("restore did not reset the boxes");
await conf.actions.configure(["4,XPR", eg.ptHex(auditor.P), "10000", "0", false]).send("xprconf@active");
lap("recovery copy stored; restore returns escrow only while paused and resets the boxes");
console.log("T3 end-to-end passed");
process.exit(0);
