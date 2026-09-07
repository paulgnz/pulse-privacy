// Live XPR testnet demo of the whole flow against the deployed `xprconf` contract.
// Signing goes through the proton CLI keychain (keys never enter this process); reads via RPC.
//   node tests/testnet-demo.mjs init        # one-time: init config with the vk + auditor key
//   node tests/testnet-demo.mjs register    # register ALICE and BOB encryption pubkeys
//   node tests/testnet-demo.mjs deposit 5000
//   node tests/testnet-demo.mjs fold alice|bob
//   node tests/testnet-demo.mjs send 1234   # alice → bob, real proof
//   node tests/testnet-demo.mjs withdraw 1000  # bob → public
//   node tests/testnet-demo.mjs balances    # decrypt everything with the local keys
// Encryption keys (TESTNET ONLY) live in tests/.testnet-keys.json (gitignored).
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import eg from "../../../circuits/lib/elgamal.mjs";
import { encodeProof, encodeVk } from "../../../circuits/lib/encode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CB = (p) => join(HERE, "../../../circuits/build", p);
// NET=mainnet switches to XPR mainnet (paul123 → paul), keys in .mainnet-keys.json
const MAINNET = process.env.NET === "mainnet";
const RPC = MAINNET ? "https://proton.greymass.com" : "https://tn1.protonnz.com";
const CONTRACT = "xprconf";
const ALICE = process.env.ALICE ?? "paul123";
const BOB = process.env.BOB ?? (MAINNET ? "paul" : "testclient1");
// TOKEN=XMD switches to Metal Dollar (6 decimals, xmd.token)
const XMD = process.env.TOKEN === "XMD";
const SYM = XMD ? "6,XMD" : "4,XPR";
const PREC = XMD ? 6 : 4;
const TOKEN_CONTRACT = XMD ? "xmd.token" : "eosio.token";
const CODE = XMD ? "XMD" : "XPR";
const KEYS = join(HERE, MAINNET ? ".mainnet-keys.json" : ".testnet-keys.json");

const [cmd, arg] = process.argv.slice(2);
const units = (xpr) => BigInt(Math.round(Number(xpr) * 10 ** PREC));
const asset = (u) => `${(Number(u) / 10 ** PREC).toFixed(PREC)} ${CODE}`;
const sh = (c) => { console.log("$", c.length > 160 ? c.slice(0, 160) + "…" : c); return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); };
const action = (contract, name, data, actor) => sh(`proton chain:set ${MAINNET ? "proton" : "proton-test"} >/dev/null && proton action ${contract} ${name} '${JSON.stringify(data)}' ${actor}`);
const post = async (path, body) => (await fetch(`${RPC}/v1/chain/${path}`, { method: "POST", body: JSON.stringify(body) })).json();
const symScope = () => { let raw = BigInt(PREC); for (let i = 0; i < 3; i++) raw |= BigInt(CODE.charCodeAt(i)) << BigInt(8 * (i + 1)); return raw.toString(); };
const nameToU64 = (n) => { // Antelope name encoding
  const cm = ".12345abcdefghijklmnopqrstuvwxyz"; let v = 0n;
  for (let i = 0; i < 12; i++) { const c = i < n.length ? BigInt(cm.indexOf(n[i])) : 0n; v |= (c & 31n) << BigInt(64 - 5 * (i + 1)); }
  if (n.length > 12) v |= BigInt(cm.indexOf(n[12])) & 15n;
  return v;
};
const txId = (out) => (out.match(/"transaction_id":\s*"([0-9a-f]{64})"/) || out.match(/tx\/([0-9a-f]{64})/) || [])[1];
const cpuOf = (out) => (out.match(/"cpu_usage_us":\s*(\d+)/) || [])[1];

await eg.init();
let keys = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, "utf8")) : null;
if (!keys) {
  keys = {}; for (const who of MAINNET ? ["alice"] : ["alice", "bob", "auditor"]) keys[who] = eg.keygen().s.toString();
  writeFileSync(KEYS, JSON.stringify(keys, null, 2)); console.log("generated testnet encryption keys →", KEYS);
}
const K = { alice: eg.keygen(keys.alice), bob: keys.bob ? eg.keygen(keys.bob) : null, auditor: keys.auditor ? eg.keygen(keys.auditor) : null };
// on mainnet the receiver's and auditor's public keys come from the chain, not from local secrets
async function pubOf(name) { const a = await acct(name); if (!a) throw new Error(`${name} not registered`); return eg.decompressHex(a.enc_pubkey); }
async function auditorPub() { const r = await post("get_table_rows", { code: CONTRACT, scope: CONTRACT, table: "config", limit: 1, json: true }); return eg.decompressHex(r.rows[0].auditor_pubkey); }
const who = { alice: ALICE, bob: BOB };

async function acct(name) {
  const r = await post("get_table_rows", { code: CONTRACT, scope: symScope(), table: "accounts", lower_bound: name, upper_bound: name, limit: 1, json: true });
  return r.rows[0];
}
async function balances() {
  for (const w of K.bob ? ["alice", "bob"] : ["alice"]) {
    const a = await acct(who[w]);
    if (!a) { console.log(`${w} (${who[w]}): not registered`); continue; }
    const avail = eg.decrypt64(eg.ctFromHex(a.avail), K[w].s);
    const pend = a.pending_count ? eg.decrypt64(eg.ctFromHex(a.pending), K[w].s) : 0n;
    const pub = (await post("get_currency_balance", { code: TOKEN_CONTRACT, account: who[w], symbol: CODE }))[0];
    console.log(`${w} (${who[w]}): confidential ${asset(avail)} + pending ${asset(pend)} (${a.pending_count}) · nonce ${a.nonce} · public ${pub}`);
  }
  const escrow = (await post("get_currency_balance", { code: TOKEN_CONTRACT, account: CONTRACT, symbol: CODE }))[0];
  console.log(`escrow (${CONTRACT}): ${escrow ?? "0"}`);
}

if (cmd === "init") {
  const vk = JSON.parse(readFileSync(CB("transfer_vk.json"), "utf8"));
  const out = action(CONTRACT, "init", { sym: SYM, token_contract: "eosio.token", auditor_pubkey: eg.ptHex(K.auditor.P), vk: encodeVk(vk), withdraw_granularity: "10000", deposit_granularity: "0" }, CONTRACT);
  console.log("init tx", txId(out));
} else if (cmd === "register") {
  for (const w of K.bob ? ["alice", "bob"] : ["alice"]) {
    if (await acct(who[w])) { console.log(`${w} already registered`); continue; }
    const out = action(CONTRACT, "register", { owner: who[w], sym: SYM, enc_pubkey: eg.ptHex(K[w].P) }, who[w]);
    console.log(`register ${w} tx`, txId(out));
  }
} else if (cmd === "deposit") {
  const out = action(TOKEN_CONTRACT, "transfer", { from: ALICE, to: CONTRACT, quantity: asset(units(arg || 5000)), memo: `conf:${ALICE}` }, ALICE);
  console.log("deposit tx", txId(out), "cpu", cpuOf(out), "µs");
} else if (cmd === "fold") {
  const w = arg || "alice";
  const out = action(CONTRACT, "applypending", { owner: who[w], sym: SYM }, who[w]);
  console.log("applypending tx", txId(out), "cpu", cpuOf(out), "µs");
} else if (cmd === "send") {
  const a = await acct(ALICE);
  const bold = eg.ctFromHex(a.avail);
  const vold = [eg.bsgs32(eg.decryptPoint(bold[0].C, bold[0].D, K.alice.s)), eg.bsgs32(eg.decryptPoint(bold[1].C, bold[1].D, K.alice.s))];
  const t0 = Date.now();
  const receiverP = K.bob ? K.bob.P : await pubOf(BOB);
  const auditorP = K.auditor ? K.auditor.P : await auditorPub();
  const wit = eg.buildTransferWitness({ sender: K.alice, receiverP, auditorP, bold, voldChunks: vold, v: units(arg || 1234), nonce: BigInt(a.nonce), senderName: nameToU64(ALICE), receiverName: nameToU64(BOB) });
  const { proof } = await snarkjs.groth16.fullProve(wit.input, CB("transfer_js/transfer.wasm"), CB("transfer_final.zkey"));
  console.log(`proof generated in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const out = action(CONTRACT, "send", { from: ALICE, sym: SYM, to: BOB, ps: eg.ptHex(K.alice.P), pr: eg.ptHex(receiverP), pa: eg.ptHex(auditorP), t: eg.tHex(wit.T), b_new: eg.ctHex(wit.Bnew), proof: encodeProof(proof) }, ALICE);
  console.log("send tx", txId(out), "cpu", cpuOf(out), "µs");
} else if (cmd === "withdraw") {
  const b = await acct(BOB);
  const bold = eg.ctFromHex(b.avail);
  const vold = [eg.bsgs32(eg.decryptPoint(bold[0].C, bold[0].D, K.bob.s)), eg.bsgs32(eg.decryptPoint(bold[1].C, bold[1].D, K.bob.s))];
  const wit = eg.buildWithdrawWitness({ owner: K.bob, auditorP: K.auditor.P, bold, voldChunks: vold, v: units(arg || 1000), nonce: BigInt(b.nonce), ownerName: nameToU64(BOB) });
  const { proof } = await snarkjs.groth16.fullProve(wit.input, CB("transfer_js/transfer.wasm"), CB("transfer_final.zkey"));
  const out = action(CONTRACT, "withdraw", { owner: BOB, quantity: asset(units(arg || 1000)), po: eg.ptHex(K.bob.P), pa: eg.ptHex(K.auditor.P), b_new: eg.ctHex(wit.Bnew), proof: encodeProof(proof) }, BOB);
  console.log("withdraw tx", txId(out), "cpu", cpuOf(out), "µs");
} else if (cmd === "balances") {
  await balances();
} else {
  console.log("usage: init | register | deposit [xpr] | fold [alice|bob] | send [xpr] | withdraw [xpr] | balances");
}
process.exit(0);
