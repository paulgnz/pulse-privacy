// Headless smoke test: load the app in REAL mode, wait for the login screen, capture console
// errors, and exercise the crypto in-page (keygen + BSGS table + a chunk decrypt) via the
// module graph. Requires a running dev server on :5175 and Playwright chromium.
import { createRequire } from "node:module";
const require = createRequire("/Users/paulgrey/dev/secondbrain.nz/website/package.json");
const { chromium } = require("playwright");
const URL = process.env.URL ?? "http://localhost:5175";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("text=Connect WebAuth", { timeout: 20000 });
const banner = await page.locator(".banner").count();
console.log("login screen rendered; mock banner present:", banner > 0);
await page.screenshot({ path: "scripts/.build/smoke-login.png" });
// exercise the real crypto inside the page through Vite's module server
const r = await page.evaluate(async () => {
  const m = await import("/src/lib/crypto/real.ts");
  const t0 = performance.now();
  const kp = await m.realBackend.generateKeypair();
  const ct = await m.realBackend.encryptAmount(12340000n + (5n << 32n), kp.pubkey);
  const t1 = performance.now();
  const v = await m.realBackend.decryptAmount(ct, kp.secret); // builds the BSGS table
  const t2 = performance.now();
  const v2 = await m.realBackend.decryptAmount(ct, kp.secret);
  const t3 = performance.now();
  return { pub: kp.pubkey.slice(0, 18), v: v.toString(), keygenEncryptMs: Math.round(t1 - t0), firstDecryptMs: Math.round(t2 - t1), secondDecryptMs: Math.round(t3 - t2), v2ok: v2 === v };
});
console.log("in-page crypto:", r);
if (process.env.PROVE) {
  const p = await page.evaluate(async () => {
    const m = await import("/src/lib/crypto/real.ts");
    const kp = await m.realBackend.generateKeypair();
    const bob = await m.realBackend.generateKeypair();
    const aud = await m.realBackend.generateKeypair();
    const ct = await m.realBackend.encryptAmount(50000000n, kp.pubkey);
    const t0 = performance.now();
    const out = await m.realBackend.proveTransfer({ sender: "paul123", receiver: "testclient1", nonce: 0n, amount: 12340000n, oldBalance: 50000000n, oldBalanceCiphertext: ct, senderKeypair: kp, receiverPubkey: bob.pubkey, auditorPubkey: aud.pubkey });
    return { proofLen: out.proof.length, ms: Math.round(performance.now() - t0) };
  });
  console.log("in-page proof:", p);
}
console.log("console errors:", errors.length ? errors : "none");
await browser.close();
process.exit(errors.length ? 1 : 0);
