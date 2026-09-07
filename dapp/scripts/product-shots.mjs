// Landing / About / statement screenshots with a real mobile viewport (Playwright).
import { createRequire } from "node:module";
const require = createRequire("/Users/paulgrey/dev/secondbrain.nz/website/package.json");
const { chromium } = require("playwright");
const BASE = process.env.URL ?? "http://localhost:5175";
const browser = await chromium.launch();
for (const width of [1280, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  const shot = async (name, path, full = false) => {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    await page.screenshot({ path: `design-review/${name}-${width}.png`, fullPage: full });
    console.log("shot", name, width, "scrollWidth", sw);
  };
  await shot("20-landing", "/");
  await shot("21-about", "/about", true);
  await shot("22-statement", "/?demo=alice");
  await shot("23-about-signedin", "/about?demo=alice");
  if (errs.length) console.log("console errors:", errs);
  await ctx.close();
}
await browser.close();
