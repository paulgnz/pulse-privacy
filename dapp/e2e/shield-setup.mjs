// the setup screens with the progress bar: signed out, sign-to-create (fresh account), and register
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const OUT = process.env.E2E_OUT ?? "/tmp";
const browser = await chromium.launch();
const errors = [];
const shot = async (url, name, vp = { width: 1100, height: 700 }) => {
  const page = await (await browser.newContext({ viewport: vp })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const label = await page.locator(".progress-label").first().textContent().catch(() => "(no progress)");
  const steps = await page.locator(".progress-steps li").evaluateAll((ls) => ls.map((l) => `${l.textContent}${l.className ? `[${l.className}]` : ""}`)).catch(() => []);
  console.log(name, "->", label, "|", steps.join(" > "));
  await page.screenshot({ path: `${OUT}/setup-${name}.png` });
  return page;
};
await shot("http://localhost:5175/shielded", "signed-out");
await shot("http://localhost:5175/shielded?demo=paul123", "unlock-registered"); // paul123 is registered: unlock only
await shot("http://localhost:5175/shielded?demo=nobody12345", "create-fresh"); // unregistered account: create, (confirm), register
await shot("http://localhost:5175/shielded?demo=nobody12345", "create-mobile", { width: 390, height: 760 });
await browser.close();
console.log("errors:", errors.length ? errors : "none");
