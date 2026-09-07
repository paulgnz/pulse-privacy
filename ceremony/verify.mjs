#!/usr/bin/env node
// Verify the whole ceremony from the published files. Anyone can run this.
//   node verify.mjs                          # checks contributions/ and final/
// Checks: every attestation's file hashes; the chain of inputs → outputs; snarkjs
// verification of the final ptau (phase 1) and of the final zkey against the circuit
// (phase 2); and that the published vk matches the final zkey.
import { execFileSync } from "node:child_process";
import { createHash, } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve("contributions");
const FINAL = resolve("final");
const snarkjs = resolve("node_modules/.bin/snarkjs");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
let failures = 0;
const fail = (m) => { failures++; console.log("FAIL", m); };
const ok = (m) => console.log("ok  ", m);

const attestations = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort().map((f) => ({ file: f, ...JSON.parse(readFileSync(join(DIR, f), "utf8")) }));
for (const phase of [1, 2]) {
  const list = attestations.filter((a) => a.phase === phase);
  console.log(`\nphase ${phase}: ${list.length} contribution(s)`);
  let prev = null;
  for (const a of list) {
    const outPath = join(DIR, a.output.file);
    if (!existsSync(outPath)) { fail(`${a.name}: missing ${a.output.file}`); continue; }
    if (sha256(outPath) !== a.output.sha256) fail(`${a.name}: ${a.output.file} hash mismatch`);
    else ok(`${a.name}: ${a.output.file} ${a.output.sha256.slice(0, 16)}…`);
    if (prev && a.input.sha256 !== prev.output.sha256) fail(`${a.name}: input does not chain from ${prev.name}`);
    prev = a;
  }
}

const finalPtau = join(FINAL, "pot16_final.ptau");
const finalZkey = join(FINAL, "transfer_final.zkey");
const vkPath = join(FINAL, "transfer_vk.json");
const r1cs = resolve("../circuits/build/transfer.r1cs");

if (existsSync(finalPtau)) {
  try { execFileSync(snarkjs, ["powersoftau", "verify", finalPtau], { stdio: "pipe", maxBuffer: 64 << 20 }); ok("phase 1: final ptau verifies"); }
  catch (e) { fail(`phase 1: ptau verification failed\n${String(e.stdout || e.message).slice(-400)}`); }
} else console.log("skip phase 1 final (final/pot16_final.ptau missing)");

if (existsSync(finalZkey)) {
  if (!existsSync(r1cs)) fail("circuits/build/transfer.r1cs missing (run `npm run compile` in circuits/)");
  else {
    try { execFileSync(snarkjs, ["zkey", "verify", r1cs, finalPtau, finalZkey], { stdio: "pipe", maxBuffer: 64 << 20 }); ok("phase 2: final zkey verifies against the circuit and the final ptau"); }
    catch (e) { fail(`phase 2: zkey verification failed\n${String(e.stdout || e.message).slice(-400)}`); }
  }
  if (existsSync(vkPath)) {
    const tmp = join(FINAL, ".vk-check.json");
    execFileSync(snarkjs, ["zkey", "export", "verificationkey", finalZkey, tmp], { stdio: "pipe" });
    const a = JSON.stringify(JSON.parse(readFileSync(tmp, "utf8")));
    const b = JSON.stringify(JSON.parse(readFileSync(vkPath, "utf8")));
    if (a === b) ok(`published vk matches the final zkey (sha256 ${sha256(vkPath).slice(0, 16)}…)`); else fail("published vk does not match the final zkey");
  }
} else console.log("skip phase 2 final (final/transfer_final.zkey missing)");

console.log(failures ? `\n${failures} failure(s)` : "\nceremony verified");
process.exit(failures ? 2 : 0);
