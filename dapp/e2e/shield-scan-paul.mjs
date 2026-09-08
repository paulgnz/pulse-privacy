// does the dapp's own scan, in the browser against the dapp's endpoints, see paul's 10 XPR deposit?
// (paul's registered public key with a dummy nullifier key: enough to find notes, not to tell spent from unspent)
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto("http://localhost:5176/shielded", { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__shield, { timeout: 20000 });
const res = await page.evaluate(async () => {
  const S = window.__shield;
  const reg = await S.registeredKey("paul");
  const r = await S.scan({ ask: 1n, pk: reg, nk: 0n });
  const all = [...r.notes, ...r.spent].map((n) => ({ index: n.index, v: n.v.toString(), kind: n.kind }));
  const { nextLeaf, rootSeq } = await S.chainTree();
  return { fingerprint: S.keyFingerprint(reg), notesSeen: all, nextLeaf, rootSeq: rootSeq.toString() };
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
