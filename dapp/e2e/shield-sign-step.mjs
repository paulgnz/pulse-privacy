// The payment flow asks for a second click to open the wallet, because a wallet window opened after
// the proof (a second or two after the first click) is blocked by browsers, often silently.
//   VITE_CRYPTO=mock VITE_NETWORK=testnet npx vite build --outDir dist-mock && npx vite preview --outDir dist-mock --port 5179
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const keys = JSON.parse(readFileSync(new URL("../../contracts/xpr-shield-tsc/tests/.testnet-shield-keys.json", import.meta.url), "utf8"));
const BASE = process.env.BASE ?? "http://localhost:5179";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "ok " : "FAIL"} ${what}`); if (!ok) failures++; };
await page.goto(`${BASE}/?demo=paul123`, { waitUntil: "networkidle" });
await page.evaluate((ask) => localStorage.setItem("pulse-privacy/shield/paul123", ask), keys.alice);
await page.goto(`${BASE}/?demo=paul123`, { waitUntil: "networkidle" });
await page.waitForSelector("text=Private balance", { timeout: 30000 });
await page.waitForTimeout(3000);
// count wallet calls: the demo session's transact is wrapped so we can see when it is reached
await page.evaluate(() => { window.__opens = 0; const o = window.open; window.open = function (...a) { window.__opens++; return o.apply(this, a); }; });
await page.click(".statement .actions button:has-text('Withdraw')");
await page.fill(".statement .form input.num", "0.1");
await page.waitForTimeout(400);
await page.click(".statement .form button.btn.private");
const panel = page.locator("[aria-label='Sign in your wallet']");
await panel.waitFor({ timeout: 60000 });
check(/withdrawal of 0\.1000 XPR is ready/.test(await panel.innerText()), "after preparing, the app asks for a second click to sign");
check((await page.evaluate(() => window.__opens)) === 0, "no wallet window was attempted before that click");
check(await page.locator("button:has-text('Sign in wallet')").isEnabled(), "the Sign in wallet button is enabled");
await page.click("button:has-text('Cancel')");
check((await panel.count()) === 0, "Cancel drops the prepared transaction");
await browser.close();
console.log("errors:", errors.length ? errors : "none");
if (failures || errors.length) process.exit(1);
