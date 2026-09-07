#!/usr/bin/env node
// Verify the whole ceremony from the published files. Anyone can run this.
//   node verify.mjs                          # checks contributions/ and final/
// Checks, per phase:
//   1. every attestation's file hash;
//   2. the chain of inputs → outputs, and that each file carries every earlier contribution
//      unchanged plus exactly one new one (read from the file itself, not from the JSON);
//   3. each attestation's signature recovers to the recorded signer key (web contributions);
//   4. snarkjs verification of the final ptau (phase 1) and of the final zkey against the
//      circuit (phase 2);
//   5. the final files are exactly the last contribution plus the announced beacon: the beacon
//      step is recomputed from the last file and the block id (confirmed by several RPCs) and
//      must match byte for byte;
//   6. the published vk matches the final zkey.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beaconId, extendsChain, ptauContributions, zkeyContributions } from "./lib/chain.mjs";

const DIR = resolve("contributions");
const FINAL = resolve("final");
const snarkjs = resolve("node_modules/.bin/snarkjs");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
let failures = 0;
const fail = (m) => { failures++; console.log("FAIL", m); };
const ok = (m) => console.log("ok  ", m);
const run = (args) => execFileSync(snarkjs, args, { stdio: "pipe", maxBuffer: 64 << 20 });
const who = (a) => a.actor ?? a.name;

const CHAIN_ID = "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0";
async function signerOf(a) {
  const { Signature, Transaction } = await import("@greymass/eosio");
  const abi = { version: "eosio::abi/1.2", types: [], structs: [{ name: "viewkey", base: "", fields: [{ name: "owner", type: "name" }, { name: "note", type: "string" }] }], actions: [{ name: "viewkey", type: "viewkey", ricardian_contract: "" }], tables: [], ricardian_clauses: [], variants: [] };
  const tx = Transaction.from(a.transaction, [{ contract: "xprconf", abi }]);
  return Signature.from(a.signature).recoverDigest(tx.signingDigest(CHAIN_ID)).toString();
}

const attestations = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort().map((f) => ({ file: f, ...JSON.parse(readFileSync(join(DIR, f), "utf8")) }));
const lastFile = {};
for (const phase of [1, 2]) {
  const list = attestations.filter((a) => a.phase === phase).sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
  const readRecords = phase === 1 ? ptauContributions : zkeyContributions;
  console.log(`\nphase ${phase}: ${list.length} contribution(s)`);
  let prev = null;
  let prevRecords = null;
  const startName = phase === 1 ? "00-start.ptau" : "00-setup.zkey";
  if (existsSync(join(DIR, startName))) prevRecords = await readRecords(join(DIR, startName));
  for (const a of list) {
    const outPath = join(DIR, a.output.file);
    if (!existsSync(outPath)) { fail(`${who(a)}: missing ${a.output.file}`); continue; }
    if (sha256(outPath) !== a.output.sha256) { fail(`${who(a)}: ${a.output.file} hash mismatch`); continue; }
    if (prev && a.input.sha256 !== prev.output.sha256) fail(`${who(a)}: input does not chain from ${who(prev)}`);
    // the file must carry every earlier contribution plus this one
    const records = await readRecords(outPath);
    if (prevRecords) {
      const ext = extendsChain(prevRecords, records);
      if (!ext.ok) fail(`${who(a)}: ${a.output.file} does not extend the previous file (${ext.reason})`);
      else if (a.contributionHash && a.contributionHash !== ext.added.hash) fail(`${who(a)}: recorded contribution hash differs from the file`);
    } else if (records.length !== (a.index ?? list.indexOf(a) + 1)) {
      fail(`${who(a)}: ${a.output.file} holds ${records.length} contributions, expected ${a.index ?? list.indexOf(a) + 1}`);
    }
    // the attestation signature (web contributions carry the signed transaction)
    if (a.transaction && a.signature) {
      try {
        const rec = await signerOf(a);
        if (a.signerKey && rec !== a.signerKey) fail(`${who(a)}: signature recovers to ${rec}, not the recorded ${a.signerKey}`);
        if (a.note && !(a.transaction.actions?.[0]?.data?.note === a.note && a.note.endsWith(a.output.sha256))) fail(`${who(a)}: signed note does not name the output hash`);
      } catch (e) {
        fail(`${who(a)}: signature check failed: ${e.message}`);
      }
    }
    ok(`${who(a)}: ${a.output.file} ${a.output.sha256.slice(0, 16)}… (${records.length} contributions in file)`);
    prev = a;
    prevRecords = records;
    lastFile[phase] = outPath;
  }
}

const finalPtau = join(FINAL, "pot16_final.ptau");
const finalZkey = join(FINAL, "transfer_final.zkey");
const vkPath = join(FINAL, "transfer_vk.json");
const r1cs = resolve("../circuits/build/transfer.r1cs");
const tmp = mkdtempSync(join(tmpdir(), "ceremony-verify-"));

async function checkBeacon(phase, last, finalPath, meta) {
  // recompute the coordinator's beacon step from the last contribution and the announced block
  const b = await beaconId(meta.beaconBlock).catch((e) => { fail(`phase ${phase}: beacon block ${meta.beaconBlock}: ${e.message}`); return null; });
  if (!b) return;
  if (b.id !== meta.beaconId) fail(`phase ${phase}: recorded beacon id ${meta.beaconId} differs from the chain's ${b.id}`);
  if (sha256(last) !== meta.last) fail(`phase ${phase}: the last contribution on disk is not the one the beacon was applied to`);
  const name = `XPR mainnet block ${meta.beaconBlock}`;
  if (phase === 1) {
    const beaconed = join(tmp, "beacon.ptau"), prepared = join(tmp, "prepared.ptau");
    run(["powersoftau", "beacon", last, beaconed, b.id, "10", `--name=${name}`]);
    run(["powersoftau", "prepare", "phase2", beaconed, prepared]);
    if (sha256(prepared) === sha256(finalPath)) ok(`phase 1: final ptau is the last contribution plus beacon block ${meta.beaconBlock}, recomputed byte for byte`);
    else fail("phase 1: recomputed beacon + prepare does not match final/pot16_final.ptau");
  } else {
    const beaconed = join(tmp, "beacon.zkey");
    run(["zkey", "beacon", last, beaconed, b.id, "10", `--name=${name}`]);
    if (sha256(beaconed) === sha256(finalPath)) ok(`phase 2: final zkey is the last contribution plus beacon block ${meta.beaconBlock}, recomputed byte for byte`);
    else fail("phase 2: recomputed beacon does not match final/transfer_final.zkey");
  }
}

if (existsSync(finalPtau)) {
  try { run(["powersoftau", "verify", finalPtau]); ok("phase 1: final ptau verifies"); }
  catch (e) { fail(`phase 1: ptau verification failed\n${String(e.stdout || e.message).slice(-400)}`); }
  const meta = join(FINAL, "phase1.json");
  if (existsSync(meta) && lastFile[1]) await checkBeacon(1, lastFile[1], finalPtau, JSON.parse(readFileSync(meta, "utf8")));
  else console.log("skip phase 1 beacon check (final/phase1.json or the last contribution missing)");
} else console.log("skip phase 1 final (final/pot16_final.ptau missing)");

if (existsSync(finalZkey)) {
  if (!existsSync(r1cs)) fail("circuits/build/transfer.r1cs missing (run `npm run compile` in circuits/)");
  else {
    try { run(["zkey", "verify", r1cs, finalPtau, finalZkey]); ok("phase 2: final zkey verifies against the circuit and the final ptau"); }
    catch (e) { fail(`phase 2: zkey verification failed\n${String(e.stdout || e.message).slice(-400)}`); }
  }
  const meta = join(FINAL, "phase2.json");
  if (existsSync(meta) && lastFile[2]) await checkBeacon(2, lastFile[2], finalZkey, JSON.parse(readFileSync(meta, "utf8")));
  else console.log("skip phase 2 beacon check (final/phase2.json or the last contribution missing)");
  if (existsSync(vkPath)) {
    const t = join(tmp, "vk-check.json");
    run(["zkey", "export", "verificationkey", finalZkey, t]);
    const a = JSON.stringify(JSON.parse(readFileSync(t, "utf8")));
    const b = JSON.stringify(JSON.parse(readFileSync(vkPath, "utf8")));
    if (a === b) ok(`published vk matches the final zkey (sha256 ${sha256(vkPath).slice(0, 16)}…)`); else fail("published vk does not match the final zkey");
  }
} else console.log("skip phase 2 final (final/transfer_final.zkey missing)");

console.log(failures ? `\n${failures} failure(s)` : "\nceremony verified");
process.exit(failures ? 2 : 0);
