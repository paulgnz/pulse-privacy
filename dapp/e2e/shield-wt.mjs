import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const OUT = process.env.E2E_OUT ?? "/tmp";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:5176/about", { waitUntil: "networkidle" });
await page.waitForSelector(".walkthrough");
for (let i = 0; i < 3; i++) {
  if (i) await page.click(".walkthrough .wt-next");
  await page.waitForTimeout(400);
  const title = await page.locator(".walkthrough .wt-story h3").textContent();
  const label = await page.locator(".walkthrough .wt-view-label").textContent();
  const who = await page.locator(".walkthrough .wt-person span:last-child").allTextContents();
  console.log(i + 1, title, "|", label, "|", who.join(" → "));
  await page.locator(".walkthrough").screenshot({ path: `${OUT}/wt-${i + 1}.png` });
}
await browser.close(); console.log("errors:", errors.length ? errors : "none");
