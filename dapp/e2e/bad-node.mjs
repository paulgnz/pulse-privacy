// one node answers the outputs table with a duplicate row and a wrong commitment; two healthy nodes remain
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const keys = JSON.parse(readFileSync(new URL("../../contracts/xpr-shield-tsc/tests/.testnet-shield-keys.json", import.meta.url), "utf8"));
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.route("https://tn1.protonnz.com/v1/chain/get_table_rows", async (route) => {
  const body = JSON.parse(route.request().postData() ?? "{}");
  if (body.table !== "outputs") return route.continue();
  const res = await route.fetch(); const j = await res.json();
  if (j.rows.length) { j.rows.push({ ...j.rows[0] }); j.rows[0] = { ...j.rows[0], cm: "00".repeat(32) }; }
  return route.fulfill({ response: res, body: JSON.stringify(j), headers: { ...res.headers(), "content-type": "application/json" } });
});
await page.goto("http://localhost:5179/?demo=paul123", { waitUntil: "networkidle" });
await page.evaluate((ask) => { localStorage.setItem("pulse-privacy/shield/paul123", ask); localStorage.setItem("pulse-privacy/shield/reveal", "1"); }, keys.alice);
await page.goto("http://localhost:5179/?demo=paul123", { waitUntil: "networkidle" });
await page.waitForSelector("text=Private balance", { timeout: 30000 });
await page.waitForTimeout(6000);
const bal = (await page.locator("section.statement").innerText()).match(/Note [0-9]+[^\n]*\n[^\n]*/)?.[0] ?? "(no note row)"; const errNote = await page.locator(".note.error, .note").allInnerTexts();
const unconfirmed = await page.locator("text=unconfirmed").count();
const reading = await page.locator("text=Reading your notes").count();
console.log("note row:", bal.replace(/\s+/g, " "), "| unconfirmed notice:", unconfirmed, "| still reading:", reading, "| notes shown:", JSON.stringify(errNote).slice(0, 160));
await browser.close(); console.log("errors:", errors.length ? errors : "none");
