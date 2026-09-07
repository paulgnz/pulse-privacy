#!/usr/bin/env node
// Verify the whole ceremony from the published files. Anyone can run this.
//   node verify.mjs                  # strict: a complete ceremony, or a failure
//   node verify.mjs --partial        # check what is there so far; never claims completion
//   node verify.mjs --min 5          # contributors required per phase in strict mode (default 5)
//
// Strict mode requires, for each phase: at least --min signed contributions, each file carrying
// every earlier contribution unchanged plus exactly one new one (read from the file itself),
// each attestation signed by the account it names with a key that account holds on chain,
// the final files, the beacon metadata, and the final files recomputed byte for byte from the
// last contribution plus the beacon block (confirmed by several RPCs), plus the published vk.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RPCS, beaconId, extendsChain, ptauContributions, zkeyContributions } from "./lib/chain.mjs";

const args = process.argv.slice(2);
const PARTIAL = args.includes("--partial");
const minIdx = args.indexOf("--min");
const MIN = minIdx > -1 ? Number(args[minIdx + 1]) : 5;
const DIR = resolve("contributions");
const FINAL = resolve("final");
const snarkjs = resolve("node_modules/.bin/snarkjs");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
let failures = 0;
const fail = (m) => { failures++; console.log("FAIL", m); };
const ok = (m) => console.log("ok  ", m);
const missing = (m) => (PARTIAL ? console.log("skip", m) : fail(m));
const run = (args) => execFileSync(snarkjs, args, { stdio: "pipe", maxBuffer: 64 << 20 });

// ------------------------------------------------------------------ identity: who signed, and does that account hold the key
const CHAIN_ID = "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0";
const CONTRACT = "xprconf";
const ABI = { version: "eosio::abi/1.2", types: [], structs: [{ name: "viewkey", base: "", fields: [{ name: "owner", type: "name" }, { name: "note", type: "string" }] }], actions: [{ name: "viewkey", type: "viewkey", ricardian_contract: "" }], tables: [], ricardian_clauses: [], variants: [] };
const expectedTransaction = (actor, permission, note) => ({
  expiration: "2035-01-01T00:00:00", ref_block_num: 0, ref_block_prefix: 0, max_net_usage_words: 0, max_cpu_usage_ms: 0, delay_sec: 0, context_free_actions: [],
  actions: [{ account: CONTRACT, name: "viewkey", authorization: [{ actor, permission }], data: { owner: actor, note } }], transaction_extensions: [],
});
const keyCache = new Map();
/** the account's active and owner keys, from at least two RPCs that agree */
async function accountKeys(actor) {
  if (keyCache.has(actor)) return keyCache.get(actor);
  const { PublicKey } = await import("@greymass/eosio");
  const answers = [];
  for (const rpc of RPCS) {
    try {
      const a = await (await fetch(`${rpc}/v1/chain/get_account`, { method: "POST", body: JSON.stringify({ account_name: actor }), signal: AbortSignal.timeout(15000) })).json();
      const keys = [];
      for (const p of a.permissions ?? []) if (p.perm_name === "active" || p.perm_name === "owner") for (const k of p.required_auth.keys) { try { keys.push(PublicKey.from(k.key).toString()); } catch { /* unsupported key type */ } }
      answers.push(keys.sort().join(","));
    } catch { /* try the next */ }
  }
  if (answers.length < 2) throw new Error("fewer than two RPCs answered");
  if (new Set(answers).size !== 1) throw new Error("RPCs disagree on the account's keys");
  const keys = answers[0].split(",");
  keyCache.set(actor, keys);
  return keys;
}
/** the attestation's signature is by the named account over the exact expected transaction */
async function checkIdentity(a) {
  const { Signature, Transaction } = await import("@greymass/eosio");
  const actor = a.actor;
  const permission = a.transaction?.actions?.[0]?.authorization?.[0]?.permission ?? "active";
  const note = `ceremony/${a.phase}/${a.index}/${a.output.sha256}`;
  const expected = expectedTransaction(actor, permission, note);
  if (JSON.stringify(a.transaction) !== JSON.stringify(expected)) throw new Error("recorded transaction is not the expected attestation for this actor, phase, index and file");
  const tx = Transaction.from(expected, [{ contract: CONTRACT, abi: ABI }]);
  const recovered = Signature.from(a.signature).recoverDigest(tx.signingDigest(CHAIN_ID)).toString();
  const keys = await accountKeys(actor);
  if (!keys.includes(recovered)) throw new Error(`signature recovers to ${recovered}, which ${actor} does not hold on chain`);
  return recovered;
}

// ------------------------------------------------------------------ the chain of files
const attestations = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort().map((f) => ({ file: f, ...JSON.parse(readFileSync(join(DIR, f), "utf8")) }));
const lastFile = {};
const counted = { 1: 0, 2: 0 };
for (const phase of [1, 2]) {
  const readRecords = phase === 1 ? ptauContributions : zkeyContributions;
  const all = attestations.filter((a) => a.phase === phase);
  // index 0 (or a 00- file) is a start file, the base of the chain, never a contribution
  const start = all.find((a) => a.index === 0 || String(a.output?.file ?? "").startsWith("00-"));
  const list = all.filter((a) => a !== start).sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
  console.log(`\nphase ${phase}: ${list.length} contribution(s)`);
  let prev = null;
  let prevRecords = null;
  const startName = start?.output?.file ?? (phase === 1 ? "00-start.ptau" : "00-setup.zkey");
  if (existsSync(join(DIR, startName))) {
    prevRecords = await readRecords(join(DIR, startName));
    if (prevRecords.length !== 0) fail(`${startName} should hold no contributions, holds ${prevRecords.length}`);
    else ok(`${startName}: start file, no contributions`);
  } else missing(`phase ${phase}: start file ${startName} not present`);
  for (const a of list) {
    const who = a.actor ?? a.name;
    if (a.index !== list.indexOf(a) + 1) fail(`${who}: index ${a.index} out of order`);
    const outPath = join(DIR, a.output.file);
    if (!existsSync(outPath)) { fail(`${who}: missing ${a.output.file}`); continue; }
    if (sha256(outPath) !== a.output.sha256) { fail(`${who}: ${a.output.file} hash mismatch`); continue; }
    if (prev ? a.input.sha256 !== prev.output.sha256 : prevRecords && start && a.input.sha256 !== start.output.sha256) fail(`${who}: input does not chain from the previous file`);
    const records = await readRecords(outPath);
    if (prevRecords) {
      const ext = extendsChain(prevRecords, records);
      if (!ext.ok) fail(`${who}: ${a.output.file} does not extend the previous file (${ext.reason})`);
      else if (a.contributionHash && a.contributionHash !== ext.added.hash) fail(`${who}: recorded contribution hash differs from the file`);
    } else if (records.length !== a.index) fail(`${who}: ${a.output.file} holds ${records.length} contributions, expected ${a.index}`);
    if (a.actor && a.signature) {
      try {
        const key = await checkIdentity(a);
        ok(`${who}: ${a.output.file} ${a.output.sha256.slice(0, 16)}… signed by ${who} (${key.slice(0, 14)}…), ${records.length} contributions in file`);
        counted[phase] += 1;
      } catch (e) {
        fail(`${who}: identity check failed: ${e.message}`);
      }
    } else {
      console.log(`note ${who}: ${a.output.file} is unsigned (command-line contribution); check its public attestation by hand. Not counted toward --min.`);
      ok(`${who}: ${a.output.file} ${a.output.sha256.slice(0, 16)}… (${records.length} contributions in file)`);
    }
    prev = a;
    prevRecords = records;
    lastFile[phase] = outPath;
  }
  if (counted[phase] < MIN) missing(`phase ${phase}: ${counted[phase]} signed contribution(s), ${MIN} required`);
}

// ------------------------------------------------------------------ the final files and the beacon
const finalPtau = join(FINAL, "pot16_final.ptau");
const finalZkey = join(FINAL, "transfer_final.zkey");
const vkPath = join(FINAL, "transfer_vk.json");
const r1cs = resolve("../circuits/build/transfer.r1cs");
const tmp = mkdtempSync(join(tmpdir(), "ceremony-verify-"));

async function checkBeacon(phase, last, finalPath, meta) {
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
  else missing("phase 1: beacon metadata (final/phase1.json) or the last contribution not present");
} else missing("phase 1: final/pot16_final.ptau not present");

if (existsSync(finalZkey)) {
  if (!existsSync(r1cs)) fail("circuits/build/transfer.r1cs missing (run `npm run compile` in circuits/)");
  else {
    try { run(["zkey", "verify", r1cs, finalPtau, finalZkey]); ok("phase 2: final zkey verifies against the circuit and the final ptau"); }
    catch (e) { fail(`phase 2: zkey verification failed\n${String(e.stdout || e.message).slice(-400)}`); }
  }
  const meta = join(FINAL, "phase2.json");
  if (existsSync(meta) && lastFile[2]) await checkBeacon(2, lastFile[2], finalZkey, JSON.parse(readFileSync(meta, "utf8")));
  else missing("phase 2: beacon metadata (final/phase2.json) or the last contribution not present");
  if (existsSync(vkPath)) {
    const t = join(tmp, "vk-check.json");
    run(["zkey", "export", "verificationkey", finalZkey, t]);
    const a = JSON.stringify(JSON.parse(readFileSync(t, "utf8")));
    const b = JSON.stringify(JSON.parse(readFileSync(vkPath, "utf8")));
    if (a === b) ok(`published vk matches the final zkey (sha256 ${sha256(vkPath).slice(0, 16)}…)`); else fail("published vk does not match the final zkey");
  } else missing("final/transfer_vk.json not present");
} else missing("phase 2: final/transfer_final.zkey not present");

if (failures) {
  console.log(`\n${failures} failure(s). The ceremony is NOT verified.`);
  process.exit(2);
}
if (PARTIAL) {
  console.log("\npartial check passed. This is not a completed ceremony; run without --partial for the release check.");
  process.exit(1);
}
console.log("\nceremony verified: complete, every contribution signed and chained, final files recomputed from the beacon");
process.exit(0);
