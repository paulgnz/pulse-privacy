// compute alice's (paul123) recovery copies in the browser: phrase copy under a test passphrase,
// committee copy to the testnet auditor key; print them for the CLI setbackup
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const OUT = process.env.E2E_OUT ?? "/tmp";
const keys = JSON.parse(readFileSync(new URL("../../contracts/xpr-shield-tsc/tests/.testnet-shield-keys.json", import.meta.url), "utf8"));
const PASS = "orbit velvet cabin ladder mango sphere tunnel";
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto("http://localhost:5176/shielded", { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__shield, { timeout: 20000 });
const res = await page.evaluate(async ({ ask, pass }) => {
  const S = window.__shield;
  const XPR = { code: "XPR", precision: 4, contract: "eosio.token", units: 10000n };
  const cfg = await S.getConfig([XPR]);
  const a = BigInt(ask);
  const t0 = performance.now();
  const phrase = await S.phraseCopy(a, pass);
  const ms = Math.round(performance.now() - t0);
  const committee = S.committeeCopy(a, cfg.auditorPk);
  const back = await S.openPhraseCopy(phrase, pass);
  let wrong = null; try { await S.openPhraseCopy(phrase, pass + " x"); } catch (e) { wrong = e.message; }
  return { phrase, committee, phraseBytes: phrase.length / 2, committeeBytes: committee.length / 2, pbkdfMs: ms, roundTrip: back === a, wrong };
}, { ask: keys.alice, pass: PASS });
console.log(JSON.stringify({ ...res, phrase: res.phrase.slice(0, 16) + "…", committee: res.committee.slice(0, 16) + "…" }, null, 1));
writeFileSync(`${OUT}/alice-backup.json`, JSON.stringify({ phrase: res.phrase, committee: res.committee, pass: PASS }));
await browser.close();
