// Regression tests distilled from the review series: a lying node must not be able to invent a
// balance, forge a payer or a withdrawal in Activity, hand the committee copy to itself, or leave a
// key behind after Forget. Run against a production preview of a mock build (port 5179), since
// React's development tracing breaks the Activity table in the dev server (see README).
//   VITE_CRYPTO=mock VITE_NETWORK=testnet npx vite build --outDir dist-mock && npx vite preview --outDir dist-mock --port 5179
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import N from "../../circuits/lib/notes.mjs";
import { Net } from "../../client/lib/net.mjs";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const keys = JSON.parse(readFileSync(new URL("../../contracts/xpr-shield-tsc/tests/.testnet-shield-keys.json", import.meta.url), "utf8"));
await N.init();
const net = new Net("testnet");
const alice = N.keygen(BigInt(keys.alice));
const BASE = process.env.BASE ?? "http://localhost:5179";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "ok " : "FAIL"} ${what}`); if (!ok) failures++; };
const fulfil = async (route, j) => { const res = await route.fetch(); return route.fulfill({ response: res, body: JSON.stringify(j), headers: { ...res.headers(), "content-type": "application/json" } }); };
const rows = async (route) => (await (await route.fetch()).json());

await page.goto(`${BASE}/?demo=paul123`, { waitUntil: "networkidle" });
await page.evaluate((ask) => { localStorage.setItem("pulse-privacy/shield/paul123", ask); localStorage.setItem("pulse-privacy/shield/reveal", "1"); }, keys.alice);
await page.goto(`${BASE}/?demo=paul123`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Private balance", { timeout: 30000 });
await page.waitForTimeout(4000);
const balanceText = async () => (await page.locator("section.statement").innerText()).match(/Private balance[\s\S]*?XPR\s+([0-9,.]+)/)?.[1] ?? "?";
const trueBalance = await balanceText();
check(/^[0-9][0-9,]*\.[0-9]{4}$/.test(trueBalance) && Number(trueBalance.replace(/,/g, "")) > 0, `an honest read gives a numeric, non-zero balance (${trueBalance})`);
if (!/^[0-9]/.test(trueBalance)) { await browser.close(); console.log("no baseline: the balance could not be read, nothing below would be tested"); process.exit(1); }

// 1. a forged note to the victim's public key, appended to the outputs of every node; and, from
//    the first node only, a copy of a real row at a fractional index (the root still matches, the
//    row must be refused and that node dropped, the others still agree)
let liar = null;
await page.route("**/v1/chain/get_table_rows", async (route) => {
  const body = JSON.parse(route.request().postData() ?? "{}");
  const host = new URL(route.request().url()).host;
  liar ??= host;
  const j = await rows(route);
  if (body.table === "outputs" && !j.more && j.rows.length) {
    const last = j.rows[j.rows.length - 1];
    j.rows.push({ ...last, index: Number(last.index) + 1, epk: "", cr: "0".repeat(48) + "10000000000000000" + "0".repeat(64), ca: "" });
    if (host === liar) j.rows.push({ ...last, index: Number(last.index) + 0.5 });
  }
  return fulfil(route, j);
});
await page.goto(`${BASE}/?demo=paul123`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Private balance", { timeout: 30000 });
await page.waitForTimeout(4000);
check((await balanceText()) === trueBalance, `forged output rows do not change the balance (${trueBalance} XPR); the fractional row from ${liar} did not stop the app`);
await page.unroute("**/v1/chain/get_table_rows");

// 2. forged history: a payer that never paid, and an invented withdrawal by the account itself
const sc = await net.scan(alice);
const recv = sc.notes.concat(sc.spent).find((n) => n.kind === "note"); const sp = sc.spent[0];
const info = { cm: recv ? N.hex32(recv.cm) : "0".repeat(64), nf: sp ? N.hex32(N.nullifier(alice.nk, sp.index)) : "0".repeat(64) };
const Z = "0".repeat(64);
const forged = [
  { timestamp: "2026-09-08T01:00:00.000", block_num: 1, trx_id: "f".repeat(64), act: { account: "xprshield", name: "spend", authorization: [{ actor: "evilnode1", permission: "active" }], data: { owner: "evilnode1", publics: Z + Z + info.cm + info.cm, amount: "0", token_id: 0, root_seq: "0" } } },
  { timestamp: "2026-09-08T02:00:00.000", block_num: 2, trx_id: "e".repeat(64), act: { account: "xprshield", name: "spend", authorization: [{ actor: "paul123", permission: "active" }], data: { owner: "paul123", publics: info.nf + Z + info.cm + info.cm, amount: "99999990000", token_id: 1, root_seq: "0" } } },
];
await page.route("**/v2/history/get_actions*", async (route) => { const j = await rows(route); if (/spend/.test(route.request().url())) j.actions = [...j.actions, ...forged]; return fulfil(route, j); });
await page.goto(`${BASE}/?demo=paul123&tab=activity`, { waitUntil: "networkidle" });
await page.waitForSelector("table.ledger", { timeout: 60000 });
await page.waitForTimeout(3000);
const activity = await page.locator("section.section").innerText();
check(/received|sent|deposited|withdrew/i.test(activity), "the honest history rows are present, so the forged ones had something to hide among");
check(!/evilnode1/.test(activity), "a forged payer is not shown in Activity");
check(!/9,999,999/.test(activity), "a forged withdrawal is not shown in Activity");
await page.unroute("**/v2/history/get_actions*");

// 3. every node reports the attacker's auditor key: the app refuses rather than sealing to it
const attacker = (() => { const k = N.keygen(12345n); return N.hex32(k.pk[0]) + N.hex32(k.pk[1]); })();
await page.route("**/v1/chain/get_table_rows", async (route) => {
  const body = JSON.parse(route.request().postData() ?? "{}");
  const j = await rows(route);
  if (body.table === "config" && j.rows?.length) j.rows[0].auditor_pubkey = attacker;
  return fulfil(route, j);
});
await page.goto(`${BASE}/?demo=paul123&tab=auditor`, { waitUntil: "networkidle" });
await page.waitForTimeout(5000);
const auditorInputs = await page.locator("input.mono").count();
const refused = await page.locator("text=not reachable").count();
check(auditorInputs === 0 && refused > 0, "a swapped auditor key stops the app instead of being used");
await page.unroute("**/v1/chain/get_table_rows");

// 4. Forget removes everything stored for the account
await page.goto(`${BASE}/?demo=paul123&tab=settings`, { waitUntil: "networkidle" });
await page.waitForSelector(".methods", { timeout: 30000 });
await page.click("summary:has-text('Advanced')");
page.once("dialog", (d) => d.accept());
await page.click("button:has-text('Forget key on this device')");
await page.waitForTimeout(1000);
const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pulse-privacy/shield/paul123")));
check(left.length === 0, `Forget leaves nothing under the account (${left.join(", ") || "none"})`);

await browser.close();
console.log("errors:", errors.length ? errors : "none");
if (failures || errors.length) process.exit(1);
