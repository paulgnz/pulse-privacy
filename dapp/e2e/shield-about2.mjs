import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const OUT = process.env.E2E_OUT ?? "/tmp";
const browser = await chromium.launch();
const errors = [];
for (const [name, vp] of [["desktop", { width: 1100, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  const page = await (await browser.newContext({ viewport: vp })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:5176/about", { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);
  const h2 = await page.locator("article.about h2").allTextContents();
  const limits = await page.locator(".limits tbody tr").evaluateAll((trs) => trs.map((t) => t.innerText.replace(/\s+/g, " ")));
  console.log(name, "sections:", h2.join(" / "));
  console.log(name, "tables:", limits.join(" || ").slice(0, 400));
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  console.log(name, "horizontal overflow:", wide);
  await page.screenshot({ path: `${OUT}/shield-about2-${name}.png`, fullPage: true });
}
await browser.close(); console.log("errors:", errors.length ? errors : "none");
