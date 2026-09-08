// 1. a blocked wallet window fails fast with a clear message instead of hanging
// 2. the send form suggests registered accounts and confirms the recipient
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const OUT = process.env.E2E_OUT ?? "/tmp";
const keys = JSON.parse(readFileSync(new URL("../../contracts/xpr-shield-tsc/tests/.testnet-shield-keys.json", import.meta.url), "utf8"));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// blocked popup: a session whose transact opens a window, with window.open stubbed to return null
await page.goto("http://localhost:5176/shielded", { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__shield);
const blocked = await page.evaluate(async () => {
  const S = window.__shield;
  window.open = () => null;
  const session = { auth: { actor: "paul123", permission: "active" }, transact: () => { window.open("https://testnet.webauth.com/auth", "_blank"); return new Promise(() => {}); } };
  const t0 = performance.now();
  try { await S.broadcast(session, [{ account: "x", name: "y", authorization: [], data: {} }]); return "resolved?!"; }
  catch (e) { return { ms: Math.round(performance.now() - t0), message: e.message }; }
});
console.log("blocked popup:", JSON.stringify(blocked));

// recipient suggestions on the mock-session server with alice's key
await page.goto("http://localhost:5175/shielded?demo=paul123", { waitUntil: "networkidle" });
await page.evaluate((ask) => localStorage.setItem("pulse-privacy/shield/paul123", ask), keys.alice);
await page.goto("http://localhost:5175/shielded?demo=paul123", { waitUntil: "networkidle" });
await page.waitForSelector("text=Shielded balance", { timeout: 20000 });
await page.click(".statement .actions button:has-text('Send')");
await page.waitForTimeout(1500);
const hint0 = await page.locator(".statement .form .field .hint").first().textContent();
const options = await page.locator("#shield-peers option").evaluateAll((os) => os.map((o) => o.value));
await page.fill(".statement .form input[list='shield-peers']", "testclient1");
await page.waitForTimeout(700);
const hint1 = await page.locator(".statement .form .field .hint").first().textContent();
await page.fill(".statement .form input[list='shield-peers']", "nobody12345");
await page.waitForTimeout(1200);
const err = await page.locator(".statement .form .field .hint.error").first().textContent().catch(() => null);
await page.fill(".statement .form input[list='shield-peers']", "testclient1");
await page.fill(".statement .form input.num", "1");
await page.waitForTimeout(500);
const btn = await page.locator(".statement .form button.btn.private").first();
console.log(JSON.stringify({ hint0, options, hint1, unknownError: err, sendEnabled: await btn.isEnabled(), sendText: await btn.textContent() }, null, 1));
await page.screenshot({ path: `${OUT}/shield-send-peers.png`, fullPage: false });
await browser.close();
console.log("errors:", errors.length ? errors : "none");
