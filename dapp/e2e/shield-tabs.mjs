// the four shielded tabs on the mock-session server with alice's key, plus the shielded How it works
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const OUT = process.env.E2E_OUT ?? "/tmp";
const keys = JSON.parse(readFileSync(new URL("../../contracts/xpr-shield-tsc/tests/.testnet-shield-keys.json", import.meta.url), "utf8"));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/Outdated Optimize Dep/.test(m.text())) { const l = m.location(); errors.push(`${(l.url||"").replace(/^http:\/\/localhost:5175/, "")}:${l.lineNumber} ${m.text().slice(0, 200)} @${page.url().slice(-20)}`); } });
await page.goto("http://localhost:5175/shielded?demo=paul123", { waitUntil: "networkidle" });
await page.evaluate((ask) => localStorage.setItem("pulse-privacy/shield/paul123", ask), keys.alice);
for (const tab of ["statement", "activity", "settings", "auditor"]) {
  await page.goto(`http://localhost:5175/shielded?demo=paul123&tab=${tab}`, { waitUntil: "networkidle" });
  await page.waitForSelector("nav.nav a[aria-current='page']", { timeout: 20000 });
  await page.waitForTimeout(tab === "auditor" ? 6000 : 4000);
  const current = await page.locator("nav.nav a[aria-current='page']").textContent();
  const text = (await page.locator("section.statement").innerText()).replace(/\s+/g, " ").slice(0, 400);
  console.log(`\n[${tab}] nav=${current}\n${text}`);
  await page.screenshot({ path: `${OUT}/shield-tab-${tab}.png`, fullPage: true });
}
// auditor: open the ledger with the testnet auditor key
await page.goto("http://localhost:5175/shielded?demo=paul123&tab=auditor", { waitUntil: "networkidle" });
await page.waitForSelector("input.mono", { timeout: 20000 });
await page.fill("input.mono", keys.auditor);
await page.click("button:has-text('Open the ledger')");
await page.waitForSelector("table.ledger, .hint.error", { timeout: 60000 });
const led = await page.locator("section.statement").innerText();
console.log("\n[auditor open]\n" + led.replace(/\s+/g, " ").slice(0, 900));
await page.screenshot({ path: `${OUT}/shield-tab-auditor-open.png`, fullPage: true });
// about on the shield app would need VITE_APP=shield; check the component renders via the confidential site route on 5175 later
await browser.close();
console.log("\nerrors:", errors.length ? errors : "none");
