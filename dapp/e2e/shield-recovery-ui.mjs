// the recovery flows on the mock-session server (5175, real testnet reads):
//  1. new passkey account with a saved key: recovery step (words, file, committee), then register screen
//  2. registered passkey account (paul123) on a new device: restore from the phrase copy on chain
//  3. Settings for the saved key: statuses from the backups row
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const OUT = process.env.E2E_OUT ?? "/tmp";
const keys = JSON.parse(readFileSync(new URL("../../contracts/xpr-shield-tsc/tests/.testnet-shield-keys.json", import.meta.url), "utf8"));
const backup = JSON.parse(readFileSync(`${OUT}/alice-backup.json`, "utf8"));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const progress = async () => `${await page.locator(".progress-label").textContent().catch(() => "(none)")} | ${(await page.locator(".progress-steps li").evaluateAll((ls) => ls.map((l) => l.textContent + (l.className ? `[${l.className}]` : "")))).join(" > ")}`;

// 1. new account, saved key present, not registered → recovery step
await page.goto("http://localhost:5175/shielded?demo=nobody12345", { waitUntil: "networkidle" });
await page.evaluate((ask) => localStorage.setItem("pulse-privacy/shield/nobody12345", ask), keys.bob);
await page.goto("http://localhost:5175/shielded?demo=nobody12345", { waitUntil: "networkidle" });
await page.waitForSelector("text=Write down your recovery phrase", { timeout: 20000 });
console.log("[recovery step]", await progress());
const words = (await page.locator(".secret.words code").textContent()).split(" ");
console.log("words:", words.length, "continue disabled before copy+tick:", await page.locator("button:has-text('Continue')").isDisabled());
await page.screenshot({ path: `${OUT}/rec-step.png`, fullPage: true });
await page.click("button:has-text('Copy phrase')");
await page.locator("label.check input").nth(1).check();
console.log("continue enabled after:", await page.locator("button:has-text('Continue')").isEnabled());
await page.click("button:has-text('Continue')");
await page.waitForSelector("text=Register your shielded key");
console.log("[register]", await progress());
console.log((await page.locator("section.statement p.muted").first().textContent()).slice(-120));
await page.screenshot({ path: `${OUT}/rec-register.png`, fullPage: true });
await page.evaluate(() => localStorage.removeItem("pulse-privacy/shield/nobody12345"));

// 2. paul123 registered, no saved key on this device, phrase copy on chain → restore
await page.goto("http://localhost:5175/shielded?demo=paul123", { waitUntil: "networkidle" });
await page.waitForSelector("text=Restore your shielded key", { timeout: 20000 });
await page.waitForSelector("input[type=password]", { timeout: 20000 });
console.log("[restore]", await progress());
await page.screenshot({ path: `${OUT}/rec-restore.png`, fullPage: true });
await page.fill("input[type=password]", "wrong words here");
await page.click("button:has-text('Restore')");
await page.waitForSelector(".note", { timeout: 20000 });
console.log("wrong phrase:", await page.locator(".note").first().textContent());
await page.fill("input[type=password]", backup.pass);
await page.click("button:has-text('Restore')");
await page.waitForSelector("text=Private balance", { timeout: 30000 });
console.log("right phrase: statement shown; saved =", await page.evaluate(() => [localStorage.getItem("pulse-privacy/shield/paul123") !== null, localStorage.getItem("pulse-privacy/shield/paul123/backedup")]));
console.log("recovery notice on statement:", await page.locator("text=Recovery is not set up").count());

// 3. settings
await page.goto("http://localhost:5175/shielded?demo=paul123&tab=settings", { waitUntil: "networkidle" });
await page.waitForSelector(".methods", { timeout: 20000 });
await page.waitForTimeout(2500);
console.log("[settings]", await page.locator(".recovery-status").textContent(), "|", (await page.locator(".method .status").allTextContents()).join(" / "));
await page.screenshot({ path: `${OUT}/rec-settings.png`, fullPage: true });
// key file restore path: forget, then paste the key file
await page.click("summary:has-text('Advanced')");
page.once("dialog", (d) => d.accept());
await page.click("button:has-text('Forget key on this device')");
await page.waitForSelector("text=Restore your shielded key", { timeout: 20000 });
await page.click("text=I have the key file instead");
await page.fill("textarea.mono", JSON.stringify({ format: "pulse-privacy/shieldkey/v1", secret: "0x" + BigInt(keys.alice).toString(16).padStart(64, "0") }));
await page.click("button:has-text('Restore')");
await page.waitForSelector("text=Private balance", { timeout: 30000 });
console.log("key file restore: ok");
await browser.close();
console.log("errors:", errors.length ? errors : "none");
