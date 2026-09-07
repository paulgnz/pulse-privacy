#!/usr/bin/env node
// Coordinator steps. The random beacon is the XPR mainnet block id at a height announced
// BEFORE the last contribution, so nobody could have chosen it.
//   node finalize.mjs phase1 <last.ptau> --beacon-block 402500000      → final/pot16_final.ptau (prepared for phase 2)
//   node finalize.mjs setup  <circuit.r1cs>                             → contributions/00-setup.zkey (start of phase 2)
//   node finalize.mjs phase2 <last.zkey>  --beacon-block 402600000      → final/transfer_final.zkey, final/transfer_vk.json, final/vk.hex
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beaconId } from "./lib/chain.mjs";

const [step, file] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const bIdx = process.argv.indexOf("--beacon-block");
const beaconBlock = bIdx > -1 ? Number(process.argv[bIdx + 1]) : null;
const snarkjs = resolve("node_modules/.bin/snarkjs");
const FINAL = resolve("final");
mkdirSync(FINAL, { recursive: true });
const run = (args) => execFileSync(snarkjs, args, { stdio: "inherit", maxBuffer: 64 << 20 });
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

async function beacon() {
  if (!beaconBlock) throw new Error("--beacon-block <height> is required (announce the height in advance)");
  // several independent RPCs must agree on the block id, and the id must encode the height
  const b = await beaconId(beaconBlock);
  console.log(`beacon: XPR mainnet block ${beaconBlock} id ${b.id} (${b.timestamp}) confirmed by ${b.sources.join(", ")}`);
  return b.id;
}

if (step === "phase1") {
  const id = await beacon();
  const beaconed = join(FINAL, "pot16_beacon.ptau");
  run(["powersoftau", "beacon", file, beaconed, id, "10", `--name=XPR mainnet block ${beaconBlock}`]);
  run(["powersoftau", "prepare", "phase2", beaconed, join(FINAL, "pot16_final.ptau"), "-v"]);
  writeFileSync(join(FINAL, "phase1.json"), JSON.stringify({ beaconBlock, beaconId: id, last: sha256(file), final: sha256(join(FINAL, "pot16_final.ptau")) }, null, 2) + "\n");
  console.log("phase 1 final:", join(FINAL, "pot16_final.ptau"));
} else if (step === "setup") {
  const out = resolve("contributions/00-setup.zkey");
  run(["groth16", "setup", file, join(FINAL, "pot16_final.ptau"), out]);
  writeFileSync(out + ".json", JSON.stringify({ phase: 2, name: "coordinator setup (no secret)", timestamp: new Date().toISOString(), input: { file: "pot16_final.ptau", sha256: sha256(join(FINAL, "pot16_final.ptau")) }, output: { file: "00-setup.zkey", sha256: sha256(out) }, contributionHash: null }, null, 2) + "\n");
  console.log("phase 2 starts from", out);
} else if (step === "phase2") {
  const id = await beacon();
  const finalZkey = join(FINAL, "transfer_final.zkey");
  run(["zkey", "beacon", file, finalZkey, id, "10", `--name=XPR mainnet block ${beaconBlock}`]);
  const vk = join(FINAL, "transfer_vk.json");
  run(["zkey", "export", "verificationkey", finalZkey, vk]);
  const { encodeVk } = await import("../circuits/lib/encode.mjs");
  const hex = encodeVk(JSON.parse(readFileSync(vk, "utf8")));
  writeFileSync(join(FINAL, "vk.hex"), hex + "\n");
  writeFileSync(join(FINAL, "phase2.json"), JSON.stringify({ beaconBlock, beaconId: id, last: sha256(file), finalZkey: sha256(finalZkey), vk: sha256(vk), vkHex: sha256(join(FINAL, "vk.hex")) }, null, 2) + "\n");
  console.log(`final zkey ${finalZkey}\nvk ${vk}\nvk hex for setvk: final/vk.hex (${hex.length / 2} bytes)`);
} else {
  console.log("usage: finalize.mjs phase1 <last.ptau> --beacon-block N | setup <circuit.r1cs> | phase2 <last.zkey> --beacon-block N");
}
