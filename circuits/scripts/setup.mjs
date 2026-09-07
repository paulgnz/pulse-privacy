// Groth16 phase-2 for transfer.circom (REHEARSAL — one local contribution; the real ceremony
// needs several independent contributors and published transcripts, design doc §2.8).
//   node scripts/setup.mjs            # build/transfer_final.zkey, build/transfer_vk.json
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const sh = (c) => { console.log("$", c); execSync(c, { stdio: "inherit" }); };

if (!existsSync("build/transfer.r1cs")) sh("npm run compile");
if (!existsSync("build/pot16.ptau") || statSync("build/pot16.ptau").size < 1_000_000)
  throw new Error("build/pot16.ptau missing or bad — generate it first (see README)");

sh("npx snarkjs groth16 setup build/transfer.r1cs build/pot16.ptau build/transfer_0000.zkey");
sh(`printf 'rehearsal contribution %s\\n' "$(date +%s)" | npx snarkjs zkey contribute build/transfer_0000.zkey build/transfer_final.zkey --name="rehearsal-1" -v`);
sh("npx snarkjs zkey verify build/transfer.r1cs build/pot16.ptau build/transfer_final.zkey");
sh("npx snarkjs zkey export verificationkey build/transfer_final.zkey build/transfer_vk.json");
console.log("setup done: build/transfer_final.zkey, build/transfer_vk.json");
