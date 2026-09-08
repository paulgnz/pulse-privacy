// a saved key that is not the registered one: set aside, restore screen, no empty balance
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const keys = JSON.parse(readFileSync(new URL("../../contracts/xpr-shield-tsc/tests/.testnet-shield-keys.json", import.meta.url), "utf8"));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:5175/shielded?demo=paul123", { waitUntil: "networkidle" });
await page.evaluate((ask) => localStorage.setItem("pulse-privacy/shield/paul123", ask), keys.bob); // bob's key under paul123
await page.goto("http://localhost:5175/shielded?demo=paul123", { waitUntil: "networkidle" });
await page.waitForSelector("text=Restore your shielded key", { timeout: 20000 });
console.log("restore screen shown; notice:", (await page.locator(".note").first().textContent().catch(() => "(none)")).slice(0, 90));
console.log("storage:", await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pulse-privacy/shield/paul123"))));
console.log("balance zero shown:", await page.locator("text=Shielded balance").count());
await browser.close(); console.log("errors:", errors.length ? errors : "none");
