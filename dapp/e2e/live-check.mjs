import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
for (const url of ["https://private.protonnz.com/", "https://testnet.private.protonnz.com/", "https://testnet.private.protonnz.com/old"]) {
  await page.goto(url, { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
  const brand = await page.locator(".brand span").textContent();
  const h = await page.locator(".page h1, .page h2").first().textContent().catch(() => "?");
  const links = await page.locator("header a").evaluateAll((as) => as.map((a) => a.textContent.trim()).filter((l) => !/Switch|XPR Network/.test(l)));
  console.log(url, "| brand:", brand, "| h:", h, "| header:", links.join(", "));
}
await browser.close(); console.log("errors:", errors.length ? errors : "none");
