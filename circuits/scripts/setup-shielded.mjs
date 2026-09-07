// Groth16 phase-2 for shielded/joinsplit.circom (REHEARSAL: one local contribution; the real
// ceremony is milestone S6). Reuses build/pot16.ptau.
//   node scripts/setup-shielded.mjs   # build/joinsplit_final.zkey, build/joinsplit_vk.json
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
const sh = (c) => { console.log("$", c); execSync(c, { stdio: "inherit" }); };
if (!existsSync("build/joinsplit.r1cs")) sh("npm run compile:shielded");
if (!existsSync("build/pot16.ptau") || statSync("build/pot16.ptau").size < 1_000_000) throw new Error("build/pot16.ptau missing");
sh("npx snarkjs groth16 setup build/joinsplit.r1cs build/pot16.ptau build/joinsplit_0000.zkey");
sh(`printf 'rehearsal contribution %s\\n' "$(date +%s)" | npx snarkjs zkey contribute build/joinsplit_0000.zkey build/joinsplit_final.zkey --name="rehearsal-1" -v`);
sh("npx snarkjs zkey verify build/joinsplit.r1cs build/pot16.ptau build/joinsplit_final.zkey");
sh("npx snarkjs zkey export verificationkey build/joinsplit_final.zkey build/joinsplit_vk.json");
console.log("setup done: build/joinsplit_final.zkey, build/joinsplit_vk.json");
