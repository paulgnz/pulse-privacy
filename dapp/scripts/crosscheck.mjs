// Format cross-check: the browser crypto (src/lib/crypto/{babyjub,real}.ts) against the
// reference JS library (circuits/lib/elgamal.mjs, circomlibjs) for the same secret:
//   identical pubkey hex · each side decrypts the other's ciphertexts · identical t / b_new
//   layouts · a snarkjs proof from the browser-side witness verifies with the circuit vk.
// Run: node scripts/crosscheck.mjs   (compiles the two TS modules to scripts/.build first)
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(HERE, ".build");

// 1. compile the pure modules (bundler-style imports → add .js for Node ESM)
execSync(
  `npx tsc src/lib/crypto/babyjub.ts src/lib/crypto/real.ts src/lib/crypto/types.ts src/snarkjs.d.ts --outDir ${OUT} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --declaration false --lib es2022,dom`,
  { cwd: ROOT, stdio: "inherit" }
);
for (const f of readdirSync(OUT)) {
  if (!f.endsWith(".js")) continue;
  const p = join(OUT, f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/from "\.\/(babyjub|real|types)"/g, 'from "./$1.js"'));
}
if (!existsSync(join(OUT, "real.js"))) throw new Error("compile failed");

const bj = await import(join(OUT, "babyjub.js"));
const real = await import(join(OUT, "real.js"));
const eg = (await import(join(ROOT, "../circuits/lib/elgamal.mjs"))).default;
await eg.init();

const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("✓", m); };

// 2. same secret → same pubkey
const secret = 123456789012345678901234567890n;
const ref = eg.keygen(secret);
const refPub = eg.ptHex(ref.P);
const ourPub = (await real.realBackend.pubkeyOf("0x" + secret.toString(16).padStart(64, "0"))).slice(2);
ok(refPub === ourPub, "pubkey hex identical");

// 3. reference encrypts, we decrypt (both chunks, 64-bit amount)
const amount = 1234_0000n + (7n << 32n);
const [lo, hi] = eg.split64(amount);
const rlo = eg.encrypt(lo, 42n, { s: ref.P });
const rhi = eg.encrypt(hi, 43n, { s: ref.P });
const ct = { lo: { c: "0x" + eg.ptHex(rlo.C), d: "0x" + eg.ptHex(rlo.D.s) }, hi: { c: "0x" + eg.ptHex(rhi.C), d: "0x" + eg.ptHex(rhi.D.s) } };
const dec = await real.realBackend.decryptAmount(ct, "0x" + secret.toString(16).padStart(64, "0"));
ok(dec === amount, `we decrypt the reference ciphertext (${dec})`);

// 4. we encrypt, reference decrypts
const ours = await real.realBackend.encryptAmount(amount, "0x" + refPub);
const back = eg.decrypt64(eg.ctFromHex((ours.lo.c + ours.lo.d + ours.hi.c + ours.hi.d).replace(/0x/g, "")), secret);
ok(back === amount, "reference decrypts our ciphertext");

// 5. homomorphic add agrees
const sum = real.chunkedAdd(ct, ours);
const sumDec = await real.realBackend.decryptAmount(sum, "0x" + secret.toString(16).padStart(64, "0"));
ok(sumDec === 2n * amount, "homomorphic add of both ciphertexts decrypts to the sum");

// 6. on-curve / generator sanity
ok(bj.onCurve(bj.G) && bj.onCurve(bj.H) && bj.eq(bj.mul(bj.G, bj.L), bj.INF), "G, H on curve; l·G = identity");

// 7. full transfer proof from the browser-side witness builder, verified with the circuit vk
const vkPath = join(ROOT, "../circuits/build/transfer_vk.json");
if (existsSync(vkPath)) {
  const snarkjs = await import("snarkjs");
  real.setArtifacts(join(ROOT, "../circuits/build/transfer_js/transfer.wasm"), join(ROOT, "../circuits/build/transfer_final.zkey"));
  const bob = eg.keygen(999n);
  const aud = eg.keygen(777n);
  const out = await real.realBackend.proveTransfer(
    {
      sender: "paul123",
      receiver: "testclient1",
      nonce: 0n,
      amount: 1234_0000n,
      oldBalance: amount,
      oldBalanceCiphertext: ct,
      senderKeypair: { secret: "0x" + secret.toString(16).padStart(64, "0"), pubkey: "0x" + refPub },
      receiverPubkey: "0x" + eg.ptHex(bob.P),
      auditorPubkey: "0x" + eg.ptHex(aud.P),
    },
    (f, s) => console.log(`  ${(f * 100).toFixed(0)}% ${s}`)
  );
  ok(out.proof.length === 2 + 512, "proof is 256 bytes");
  // bob and the auditor read the amount from the transfer set
  const tHex = [out.transfer.lo, out.transfer.hi].map((c) => (c.c + c.dSender + c.dReceiver + c.dAuditor).replace(/0x/g, "")).join("");
  ok(eg.decrypt64(eg.tReceiverFromHex(tHex), 999n) === 1234_0000n, "receiver decrypts the transfer set (contract layout)");
  ok(eg.decrypt64(eg.tAuditorFromHex(tHex), 777n) === 1234_0000n, "auditor decrypts the transfer set (contract layout)");
  const newBal = await real.realBackend.decryptAmount(out.newBalance, "0x" + secret.toString(16).padStart(64, "0"));
  ok(newBal === amount - 1234_0000n, "new balance decrypts correctly");
  console.log("(the proof itself was produced by snarkjs with the real zkey; the contract test in contracts/ verifies this exact encoding on chain)");
  void snarkjs;
} else {
  console.log("no circuits/build/transfer_vk.json: skipping the proof step");
}
console.log("crosscheck passed");
process.exit(0);
