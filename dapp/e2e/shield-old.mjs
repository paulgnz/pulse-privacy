import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const OUT = process.env.E2E_OUT ?? "/tmp";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 1000 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
for (const who of ["alice", "bob"]) {
  await page.goto(`http://localhost:5175/old?demo=${who}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);
  const h = await page.locator(".page h2").first().textContent().catch(() => "?");
  const actions = await page.locator(".statement .actions button").allTextContents().catch(() => []);
  const notice = await page.locator(".note").first().textContent().catch(() => "");
  const links = await page.locator("header a").evaluateAll((as) => as.map((a) => a.textContent.trim()).filter((l) => !/Switch|XPR Network/.test(l)));
  const tabs = await page.locator("nav.nav a").allTextContents();
  console.log(`${who}: h=${h} | tabs=[${tabs.join(",")}] | actions=[${actions.join(",")}] | header=[${links.join(",")}]\n   notice: ${notice.slice(0, 120)}`);
  await page.screenshot({ path: `${OUT}/old-${who}.png`, fullPage: true });
  await page.goto(`http://localhost:5175/?demo=${who}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  console.log(`   home header: [${(await page.locator("header a").evaluateAll((as) => as.map((a) => a.textContent.trim()).filter((l) => !/Switch|XPR Network/.test(l)))).join(",")}]`);
}
await browser.close(); console.log("errors:", errors.length ? errors : "none");
