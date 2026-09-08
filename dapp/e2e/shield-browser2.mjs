// Signed model: in the browser, scan alice's notes on testnet, build a join-split bound to
// paul123, prove it, verify the proof locally against the circuit's vk, and check the action
// the wallet would sign carries 28 words and names the sender. No broadcast (needs the wallet).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const keys = JSON.parse(readFileSync(new URL("../../contracts/xpr-shield-tsc/tests/.testnet-shield-keys.json", import.meta.url), "utf8"));
const vk = JSON.parse(readFileSync("/Users/paulgrey/dev/pulse-privacy/circuits/build/joinsplit_vk.json", "utf8"));
const BASE = process.env.BASE ?? "http://localhost:5176";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/Outdated Optimize Dep/.test(m.text())) errors.push(m.text()); });
await page.goto(`${BASE}/shielded`, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__shield, { timeout: 20000 });
const res = await page.evaluate(async ({ aliceAsk, bobAsk, vk }) => {
  const S = window.__shield;
  const XPR = { code: "XPR", precision: 4, contract: "eosio.token", units: 10000n };
  const cfg = await S.getConfig([XPR]);
  const alice = S.keygen(BigInt(aliceAsk)), bob = S.keygen(BigInt(bobAsk));
  const a = await S.scan(alice), b = await S.scan(bob);
  const sum = (ns) => ns.reduce((s, n) => s + n.v, 0n);
  const out = { alice: { notes: a.notes.length, balance: sum(a.notes).toString() }, bob: { notes: b.notes.length, balance: sum(b.notes).toString() } };
  const fakeSession = { auth: { actor: "paul123", permission: "active" }, transact: async () => ({}) };
  const t0 = performance.now();
  const prep = await S.prepareSend(fakeSession, alice, cfg, XPR, "testclient1", 10000n, () => {});
  out.proveMs = Math.round(performance.now() - t0);
  const d = prep.action.data;
  out.action = { name: prep.action.name, owner: d.owner, signer: prep.action.authorization[0].actor, words: d.publics.length / 64, amount: d.amount, token_id: d.token_id, root_seq: d.root_seq, proofBytes: d.proof.length / 2, bytes: d.proof.length / 2 + d.publics.length / 2 + 17 };
  // verify the proof locally: rebuild the 27 verifier words as the contract would
  const wb = d.publics.match(/.{64}/g).map((x) => BigInt("0x" + x));
  const w = wb.map((x) => x.toString());
  const reg = await S.registeredKey("paul123");
  const { tree } = await S.chainTree();
  const epk = [S.decompressPoint(wb[4]), S.decompressPoint(wb[5])];
  const signals = [...w.slice(0, 4), ...epk.flat().map(String), ...w.slice(6, 16), reg[0].toString(), reg[1].toString(), tree.root.toString(), d.amount, "0", "0", S.nameToU64("paul123").toString(), cfg.auditorPk[0].toString(), cfg.auditorPk[1].toString()];
  const proofObj = { pi_a: [BigInt("0x" + d.proof.slice(0, 64)).toString(), BigInt("0x" + d.proof.slice(64, 128)).toString(), "1"],
    pi_b: [[BigInt("0x" + d.proof.slice(192, 256)).toString(), BigInt("0x" + d.proof.slice(128, 192)).toString()], [BigInt("0x" + d.proof.slice(320, 384)).toString(), BigInt("0x" + d.proof.slice(256, 320)).toString()], ["1", "0"]],
    pi_c: [BigInt("0x" + d.proof.slice(384, 448)).toString(), BigInt("0x" + d.proof.slice(448, 512)).toString(), "1"], protocol: "groth16", curve: "bn128" };
  out.verifiesAsContractWould = await S.verify(vk, signals, proofObj);
  const wrongSigner = signals.slice(); wrongSigner[24] = S.nameToU64("testclient1").toString();
  out.rejectsOtherSigner = !(await S.verify(vk, wrongSigner, proofObj));
  return out;
}, { aliceAsk: keys.alice, bobAsk: keys.bob, vk });
console.log(JSON.stringify(res, null, 1));
await browser.close();
console.log("errors:", errors.length ? errors : "none");
