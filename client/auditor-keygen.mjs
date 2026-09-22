#!/usr/bin/env node
// Generate the committee's auditor viewing key for a Private XPR contract, on this machine.
//   node client/auditor-keygen.mjs [path]        default ~/.private-xpr/mainnet/auditor-privatexpr.json
// Writes the private key file with mode 600 and refuses to overwrite one. Prints only the public
// key (the value for the contract's `init` and for the app's and client's pinned `auditorPk`).
// The secret never appears on screen. The file works as PRIVATEXPR_AUDITOR_KEY for `audit` and
// `recover`. Keep it offline and give the committee its copy under the same custody as v1's key.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import N from "../circuits/lib/notes.mjs";

await N.init();
const path = resolve(process.argv[2] ?? join(homedir(), ".private-xpr", "mainnet", "auditor-privatexpr.json"));
if (existsSync(path)) { console.error(`${path} exists; refusing to overwrite an auditor key`); process.exit(1); }
const keys = N.keygen();
if (keys.ask === 0n) { console.error("degenerate key; run again"); process.exit(1); }
const publicKey = N.hex32(keys.pk[0]) + N.hex32(keys.pk[1]);
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, JSON.stringify({
  format: "pulse-privacy/auditorkey/v1",
  purpose: "Private XPR auditor viewing key (committee). Opens every note's audit copy. Cannot spend.",
  contract: "privatexpr",
  network: "xpr-mainnet",
  created: new Date().toISOString(),
  publicKey,
  secret: "0x" + N.hex32(keys.ask),
}, null, 2) + "\n", { mode: 0o600 });
chmodSync(path, 0o600);
// read it back the way `audit` does and check it yields the same public key
const back = JSON.parse(readFileSync(path, "utf8"));
const again = N.keygen(BigInt(back.secret));
if (N.hex32(again.pk[0]) + N.hex32(again.pk[1]) !== publicKey) { console.error("read-back check failed; do not use this file"); process.exit(1); }
console.log(`written: ${path} (mode 600; the secret is inside, not shown)`);
console.log(`public key: ${publicKey}`);
