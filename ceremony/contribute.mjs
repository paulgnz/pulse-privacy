#!/usr/bin/env node
// One contribution to the ceremony. Works for both phases by file extension:
//   node contribute.mjs in.ptau out.ptau --name "Alice @ Metallicus"      (phase 1, universal)
//   node contribute.mjs in.zkey out.zkey --name "Alice @ Metallicus"      (phase 2, circuit)
// Entropy = 64 bytes from the OS + whatever you type when prompted (type a long random
// sentence; it is never stored). Writes <out>.json with the hashes you should publish.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { createInterface } from "node:readline";

const [inFile, outFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const nameIdx = process.argv.indexOf("--name");
const name = nameIdx > -1 ? process.argv[nameIdx + 1] : null;
if (!inFile || !outFile || !name) {
  console.error('usage: node contribute.mjs <in.ptau|in.zkey> <out> --name "Your name @ organisation"');
  process.exit(1);
}
if (!existsSync(inFile)) { console.error(`missing ${inFile}`); process.exit(1); }
const ext = extname(inFile);
if (ext !== ".ptau" && ext !== ".zkey") { console.error("input must be .ptau (phase 1) or .zkey (phase 2)"); process.exit(1); }

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const ask = (q) => new Promise((r) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); r(a); }); });

console.log(`Contribution to ${ext === ".ptau" ? "phase 1 (universal)" : "phase 2 (transfer circuit)"} as "${name}"`);
console.log(`input  ${inFile}\n       sha256 ${sha256(inFile)}`);
const typed = await ask("Type a long random sentence and press enter (not stored): ");
const entropy = randomBytes(64).toString("hex") + typed;

const snarkjs = resolve("node_modules/.bin/snarkjs");
const args = ext === ".ptau"
  ? ["powersoftau", "contribute", inFile, outFile, `--name=${name}`, `--entropy=${entropy}`, "-v"]
  : ["zkey", "contribute", inFile, outFile, `--name=${name}`, `--entropy=${entropy}`, "-v"];
const t0 = Date.now();
const out = execFileSync(snarkjs, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
const hashLines = out.split("\n").filter((l) => /^\s*[0-9a-f]{8}( [0-9a-f]{8}){3}\s*$/i.test(l)).map((l) => l.trim());
const contributionHash = hashLines.length ? hashLines.slice(-4).join(" ").replace(/\s+/g, "") : null;

const attestation = {
  phase: ext === ".ptau" ? 1 : 2,
  name,
  timestamp: new Date().toISOString(),
  input: { file: basename(inFile), sha256: sha256(inFile) },
  output: { file: basename(outFile), sha256: sha256(outFile) },
  contributionHash,
  seconds: Math.round((Date.now() - t0) / 1000),
  tool: "snarkjs " + JSON.parse(readFileSync(resolve("node_modules/snarkjs/package.json"), "utf8")).version,
};
writeFileSync(`${outFile}.json`, JSON.stringify(attestation, null, 2) + "\n");
console.log("\nDone. Publish this (tweet / post / sign it), then send the output file and its .json to the coordinator:");
console.log(JSON.stringify({ name, output_sha256: attestation.output.sha256, contribution_hash: contributionHash }, null, 2));
console.log("\nNow destroy anything that could hold your entropy (close this terminal; reboot if you used a VM).");
