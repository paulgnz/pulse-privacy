// Screenshot every screen and wizard step in simulation mode (dev server on :5175 started with
// VITE_CRYPTO=mock). Output: design-review/<name>-<width>.png
//   node scripts/design-shots.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire("/Users/paulgrey/dev/secondbrain.nz/website/package.json");
const { chromium } = require("playwright");

const BASE = process.env.URL ?? "http://localhost:5175";
const OUT = "design-review";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];

for (const width of [1280, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${width}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${width}: ${m.text()}`); });
  const shot = async (name) => {
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: true });
    console.log("shot", name, width);
  };
  const go = async (q, waitFor) => {
    await page.goto(`${BASE}/?${q}`, { waitUntil: "networkidle" });
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 });
  };

  // reset the simulated pool so the run is reproducible
  await go("demo=alice&tab=settings", "text=Simulation");
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("pulse-privacy/mockpool/") || k === "pulse-privacy/token") localStorage.removeItem(k); sessionStorage.clear(); });

  // wizard steps
  await go("demo=alice&wizard=connect", "text=Connect wallet"); await shot("01-connect");
  await go("demo=alice&wizard=unlock", "text=Sign to unlock"); await shot("02-unlock");
  await go("demo=alice&wizard=unlock-pending", "text=Waiting for your wallet"); await shot("02b-unlock-pending");
  await go("demo=alice&wizard=unlock-done", "text=Unlocked"); await shot("02c-unlock-done");
  await go("demo=alice&wizard=key-import", "text=Choose key file"); await shot("02d-key-import");
  await go("demo=alice&wizard=key-create", "text=Create key"); await shot("02e-key-create");
  await go("demo=alice&wizard=key-backup", "text=Save your backup"); await shot("02f-key-backup");
  await go("demo=alice&wizard=register", "text=Register"); await shot("03-register");
  await go("demo=alice&wizard=register-signing", "text=Waiting for your wallet"); await shot("03b-register-signing");
  await go("demo=alice&wizard=deposit", "text=First deposit"); await shot("04-first-deposit");

  // statement
  await go("demo=alice", "text=Statement");
  await page.waitForSelector("text=Reveal");
  await shot("10-statement-hidden");
  await page.click("text=Reveal");
  await page.waitForSelector("text=Hide");
  await shot("11-statement-revealed");

  // the same statement with XMD selected (6 decimals); the choice is remembered, so switch back after
  await page.click(".nav .tokens button:has-text('XMD')");
  await page.waitForSelector("text=Public XMD");
  await page.waitForSelector("text=Hide"); // reveal is remembered for the session
  await shot("11b-statement-xmd");
  await page.click("button:has-text('Send')");
  await page.waitForSelector("input[placeholder='0.000000']");
  await page.fill("input[placeholder='bob']", "bob");
  await page.fill("input[placeholder='0.000000']", "12.5");
  await shot("11d-send-xmd");
  await page.click("button:has-text('Cancel')");
  await page.click(".nav .tokens button:has-text('XPR')");
  await page.waitForSelector("text=Public XPR");
  await page.waitForSelector("text=Hide");

  // forms
  await page.click("button:has-text('Send')");
  await page.waitForSelector("input[placeholder='bob']");
  await page.fill("input[placeholder='bob']", "bob");
  await page.fill("input[placeholder='0.0000']", "1234");
  await shot("12-send");
  await page.click("button:has-text('Cancel')");
  await page.click("button:has-text('Deposit')");
  await page.waitForSelector("text=ordinary XPR transfer");
  await page.fill("input[placeholder='0.0000']", "1234.5679");
  await shot("13-deposit");
  await page.click("button:has-text('Cancel')");

  // simulate an incoming payment, then a withdrawal that matches it
  await go("demo=alice&tab=settings", "text=Simulation");
  await page.fill("input[aria-label='Simulated amount']", "1234");
  await page.click("button:has-text('Receive')");
  await page.waitForSelector("text=paid you");
  await go("demo=alice", "text=Statement");
  await page.click("button:has-text('Withdraw')");
  await page.waitForSelector("text=Withdrawing moves XPR");
  await page.fill("input[placeholder='0.0000']", "1234");
  await page.waitForSelector("text=easy to link");
  await shot("14-withdraw-warning");

  // do a real (simulated) send so activity has hidden rows
  await go("demo=alice&form=send", "input[placeholder='bob']");
  await page.fill("input[placeholder='bob']", "bob");
  await page.fill("input[placeholder='0.0000']", "250");
  await page.click("button:has-text('Send 250')");
  await page.waitForSelector("text=Sent 250", { timeout: 30000 });

  await go("demo=alice&tab=activity", "text=Activity"); await shot("15-activity");
  await page.click("text=Hide what only you can read"); await shot("15b-activity-hidden");
  await go("demo=alice&tab=settings", "text=Encryption key"); await shot("16-settings");
  await go("demo=alice&tab=auditor", "text=Viewing key");
  await page.click("text=use it");
  await page.click("button:has-text('Open the ledger')");
  await page.waitForSelector("text=Transfers", { timeout: 30000 });
  await page.waitForTimeout(400);
  await shot("17-auditor");
  await ctx.close();
}
await browser.close();
console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "no console errors");
process.exit(errors.length ? 1 : 0);
