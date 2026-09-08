// Live XPR testnet demo against the deployed `xprshield` contract (milestone S4).
// Chain writes go through the proton CLI keychain (never a raw key here); reads use RPC.
//
//   node tests/testnet-demo.mjs keys                      # generate alice/bob/auditor secrets (gitignored)
//   node tests/testnet-demo.mjs setup                     # init, addtoken XPR + XMD, register alice and bob
//   node tests/testnet-demo.mjs deposit alice 500         # alice (paul123) deposits 500 XPR
//   node tests/testnet-demo.mjs scan bob                  # notes and balance from the chain alone
//   node tests/testnet-demo.mjs send alice bob 123.4      # shielded payment, signed by paul123
//   node tests/testnet-demo.mjs withdraw bob 100          # to bob's own public account, signed by testclient1
//   node tests/testnet-demo.mjs audit                     # the auditor's ledger with names
// TOKEN=XMD switches to Metal Dollar (6 decimals, xmd.token, token id 2).
import * as snarkjs from "snarkjs";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import N from "../../../circuits/lib/notes.mjs";
import { encodeInputs, encodeProof, encodeVk } from "../../../circuits/lib/encode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CB = (p) => join(HERE, "../../../circuits/build", p);
const RPC = process.env.RPC ?? "https://tn1.protonnz.com";
const CONTRACT = "xprshield";
const ACCOUNTS = { alice: "paul123", bob: "testclient1" };
const XMD = process.env.TOKEN === "XMD";
const SYM = XMD ? "6,XMD" : "4,XPR";
const PREC = XMD ? 6 : 4;
const CODE = XMD ? "XMD" : "XPR";
const TOKEN_CONTRACT = XMD ? "xmd.token" : "eosio.token";
const TOKEN_ID = XMD ? N.TOKENS.XMD : N.TOKENS.XPR;
const KEYS = join(HERE, ".testnet-shield-keys.json");

const [cmd, ...args] = process.argv.slice(2);
const units = (x) => BigInt(Math.round(Number(x) * 10 ** PREC));
const asset = (u) => `${(Number(u) / 10 ** PREC).toFixed(PREC)} ${CODE}`;
const hex = N.hex32;
const ptHex = (p) => hex(p[0]) + hex(p[1]);
const words = (h) => (h.match(/.{64}/g) ?? []).map((w) => BigInt("0x" + w));
const sh = (c) => {
  console.log("$", c.length > 160 ? c.slice(0, 160) + "…" : c);
  const out = execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (/error|assert|failure/i.test(out) && !/"transaction_id"/.test(out)) throw new Error(out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => /error|assert|failure|hint/i.test(l)).join(" | ").slice(0, 400));
  return out;
};
const action = (contract, name, data, actor) => sh(`proton chain:set proton-test >/dev/null && proton action ${contract} ${name} '${JSON.stringify(data)}' ${actor}`);
const post = async (path, body) => (await fetch(`${RPC}/v1/chain/${path}`, { method: "POST", body: JSON.stringify(body) })).json();
const rows = async (table, extra = {}) => {
  const out = [];
  let lower = undefined;
  for (;;) {
    const r = await post("get_table_rows", { code: CONTRACT, scope: CONTRACT, table, json: true, limit: 1000, lower_bound: lower, ...extra });
    out.push(...r.rows);
    if (!r.more || r.rows.length === 0) return out;
    lower = (BigInt(r.rows[r.rows.length - 1].index ?? r.rows[r.rows.length - 1].key) + 1n).toString();
  }
};
const txId = (out) => (out.match(/"transaction_id":\s*"([0-9a-f]{64})"/) || out.match(/tx\/([0-9a-f]{64})/) || [])[1];
const cpuOf = (out) => (out.match(/"cpu_usage_us":\s*(\d+)/) || [])[1];
const explorer = (id) => `https://testnet.explorer.xprnetwork.org/transaction/${id}`;

await N.init();
let keys = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, "utf8")) : null;
if (cmd === "keys" || !keys) {
  if (keys) throw new Error(`${KEYS} exists; delete it first if you really want new keys`);
  keys = {};
  for (const who of ["alice", "bob", "auditor"]) keys[who] = N.randScalar().toString();
  writeFileSync(KEYS, JSON.stringify(keys, null, 2));
  console.log("generated shielded testnet keys →", KEYS);
  if (cmd === "keys") process.exit(0);
}
const K = Object.fromEntries(Object.entries(keys ?? {}).map(([w, s]) => [w, N.keygen(BigInt(s))]));

async function chainTree() {
  const tree = await post("get_table_rows", { code: CONTRACT, scope: CONTRACT, table: "tree", json: true, limit: 1 });
  const next = Number(tree.rows[0].next_leaf);
  const rootSeq = Number(tree.rows[0].root_seq);
  const leaves = await rows("leaves");
  const byIndex = new Map(leaves.map((l) => [Number(l.index), BigInt("0x" + l.cm)]));
  const t = new N.Tree();
  for (let i = 0; i < next; i++) t.append(byIndex.get(i) ?? 0n);
  if (hex(t.root) !== tree.rows[0].root) throw new Error(`local root ${hex(t.root)} != chain root ${tree.rows[0].root}`);
  t.rootSeq = rootSeq;
  return t;
}

/** every unspent note of `who`, from the outputs, leaves and nullifiers tables */
async function scan(who) {
  const k = K[who];
  const outs = await rows("outputs");
  const leaves = new Map((await rows("leaves")).map((l) => [Number(l.index), BigInt("0x" + l.cm)]));
  const spent = new Set((await rows("nullifiers")).map((n) => n.nf));
  const mine = [];
  for (const o of outs) {
    const index = Number(o.index);
    const cm = leaves.get(index);
    if (cm === undefined) continue;
    let note = null;
    if (o.epk.length === 0) {
      const [packed, r] = words(o.cr);
      const [v, token] = N.unpack(packed);
      const cand = { pk: k.pk, v, token, r };
      if (N.commitment(cand) === cm) note = { ...cand, cm };
    } else {
      note = N.tryDecryptReceiver(k, N.decompressPoint(words(o.epk)[0]), words(o.cr), cm);
    }
    if (!note || note.v === 0n) continue; // zero-value change notes are real but not worth spending
    const nf = N.nullifier(k.nk, index);
    if (spent.has(hex(nf))) continue;
    mine.push({ ...note, index });
  }
  return mine;
}

function pick(notes, amount) {
  const same = notes.filter((n) => n.token === TOKEN_ID).sort((a, b) => (a.v > b.v ? -1 : 1));
  const chosen = [];
  let sum = 0n;
  for (const n of same) { if (sum >= amount || chosen.length === 2) break; chosen.push(n); sum += n.v; }
  if (sum < amount) throw new Error(`not enough in two notes: have ${asset(sum)} in the largest two, need ${asset(amount)}${same.length > 2 ? " (consolidate first: send yourself the total)" : ""}`);
  return chosen;
}

async function submit(js, who, pub, label) {
  const t0 = Date.now();
  console.log("proving…");
  const { proof } = await snarkjs.groth16.fullProve(js.input, CB("joinsplit_js/joinsplit.wasm"), CB("joinsplit_final.zkey"));
  console.log(`proof in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const out = action(CONTRACT, "spend", { owner: ACCOUNTS[who], proof: encodeProof(proof), publics: encodeInputs(N.actionPublics(js.expected)), amount: (pub.vPub ?? 0n).toString(), token_id: pub.vPub ? Number(pub.tokenPub) : 0, root_seq: pub.seq }, `${ACCOUNTS[who]}@active`);
  console.log(`${label}: tx ${txId(out)} cpu ${cpuOf(out)} µs\n${explorer(txId(out))}`);
}

if (cmd === "reset") {
  action(CONTRACT, "pause", { paused: true }, `${CONTRACT}@active`);
  action(CONTRACT, "reset", {}, `${CONTRACT}@active`);
  console.log("tables wiped; run setup");
} else if (cmd === "setup") {
  const vk = JSON.parse(readFileSync(CB("joinsplit_vk.json"), "utf8"));
  const cfg = await post("get_table_rows", { code: CONTRACT, scope: CONTRACT, table: "config", json: true, limit: 1 });
  if (cfg.rows.length === 0) action(CONTRACT, "init", { auditor_pubkey: ptHex(K.auditor.pk), vk: encodeVk(vk) }, `${CONTRACT}@active`);
  action(CONTRACT, "addtoken", { sym: "4,XPR", token_contract: "eosio.token", token_id: 1, max_pool: 1_000_000_0000, max_deposit: 10_000_0000, min_deposit: 1_0000 }, `${CONTRACT}@active`);
  action(CONTRACT, "addtoken", { sym: "6,XMD", token_contract: "xmd.token", token_id: 2, max_pool: 100_000_000000, max_deposit: 100_000000, min_deposit: 1_000000 }, `${CONTRACT}@active`);
  const registered = new Set((await rows("keys")).map((r) => r.owner));
  for (const who of ["alice", "bob"]) if (!registered.has(ACCOUNTS[who])) action(CONTRACT, "register", { owner: ACCOUNTS[who], pubkey: ptHex(K[who].pk) }, `${ACCOUNTS[who]}@active`);
  console.log("setup done");
} else if (cmd === "deposit") {
  const [who, amt] = args;
  const note = N.newNote(K[who].pk, units(amt), TOKEN_ID);
  const out = action(TOKEN_CONTRACT, "transfer", { from: ACCOUNTS[who], to: CONTRACT, quantity: asset(note.v), memo: `shield:${hex(note.r)}` }, `${ACCOUNTS[who]}@active`);
  console.log(`deposit arrived: tx ${txId(out)} cpu ${cpuOf(out)} µs`);
  const out2 = action(CONTRACT, "deposit", { owner: ACCOUNTS[who], r: hex(note.r) }, `${ACCOUNTS[who]}@active`);
  console.log(`deposit placed: tx ${txId(out2)} cpu ${cpuOf(out2)} µs\n${explorer(txId(out2))}`);
} else if (cmd === "finish") {
  // place any arrived deposits of `who` that were never finished
  const who = args[0];
  const credits = (await rows("credits", "id")).filter((c) => c.owner === ACCOUNTS[who]);
  if (!credits.length) console.log("no unfinished deposits");
  for (const c of credits) { const out = action(CONTRACT, "deposit", { owner: ACCOUNTS[who], r: c.r }, `${ACCOUNTS[who]}@active`); console.log(`placed ${c.amount} units: tx ${txId(out)}`); }
} else if (cmd === "scan") {
  const notes = await scan(args[0]);
  for (const n of notes) console.log(`  leaf ${n.index}: ${n.token === N.TOKENS.XPR ? (Number(n.v) / 1e4).toFixed(4) + " XPR" : (Number(n.v) / 1e6).toFixed(6) + " XMD"}`);
  const bal = (id) => notes.filter((n) => n.token === id).reduce((s, n) => s + n.v, 0n);
  console.log(`${args[0]} (${ACCOUNTS[args[0]]}): ${(Number(bal(N.TOKENS.XPR)) / 1e4).toFixed(4)} XPR, ${(Number(bal(N.TOKENS.XMD)) / 1e6).toFixed(6)} XMD in ${notes.length} notes`);
} else if (cmd === "send") {
  const [from, to, amt] = args;
  const amount = units(amt);
  const notes = pick(await scan(from), amount);
  console.log(`spending ${notes.map((n) => `leaf ${n.index} (${asset(n.v)})`).join(", ")}`);
  const tree = await chainTree();
  console.log(`tree rebuilt from ${tree.size} leaves, root ${hex(tree.root).slice(0, 12)}…`);
  const toKey = (await rows("keys")).find((r) => r.owner === ACCOUNTS[to]);
  if (!toKey) throw new Error(`${to} has not registered`);
  const auditor = (await post("get_table_rows", { code: CONTRACT, scope: CONTRACT, table: "config", json: true, limit: 1 })).rows[0].auditor_pubkey;
  const change = notes.reduce((s, n) => s + n.v, 0n) - amount;
  const js = N.buildJoinSplit({ keys: K[from], tree, auditorPk: words(auditor), sender: N.nameToU64(ACCOUNTS[from]), inputs: notes.map((n) => ({ note: n, index: n.index })), outputs: [{ pk: words(toKey.pubkey), v: amount }, { pk: K[from].pk, v: change }] });
  await submit(js, from, { seq: tree.rootSeq }, `${from} → ${to} ${asset(amount)} (signed by ${ACCOUNTS[from]}; receiver and amount hidden)`);
} else if (cmd === "withdraw") {
  const [who, amt] = args;
  const amount = units(amt);
  const notes = pick(await scan(who), amount);
  const tree = await chainTree();
  const auditor = (await post("get_table_rows", { code: CONTRACT, scope: CONTRACT, table: "config", json: true, limit: 1 })).rows[0].auditor_pubkey;
  const change = notes.reduce((s, n) => s + n.v, 0n) - amount;
  const pub = { vPub: amount, tokenPub: TOKEN_ID, to: N.nameToU64(ACCOUNTS[who]) };
  const js = N.buildJoinSplit({ keys: K[who], tree, auditorPk: words(auditor), sender: N.nameToU64(ACCOUNTS[who]), inputs: notes.map((n) => ({ note: n, index: n.index })), outputs: [{ pk: K[who].pk, v: 0n }, { pk: K[who].pk, v: change }], ...pub });
  await submit(js, who, { ...pub, seq: tree.rootSeq }, `${who} withdraws ${asset(amount)} to ${ACCOUNTS[who]}`);
} else if (cmd === "audit") {
  const names = new Map((await rows("keys")).map((r) => [r.pubkey.slice(0, 64), r.owner]));
  const leaves = new Map((await rows("leaves")).map((l) => [Number(l.index), BigInt("0x" + l.cm)]));
  for (const o of await rows("outputs")) {
    const index = Number(o.index);
    const cm = leaves.get(index);
    if (o.epk.length === 0) { const [v, token] = N.unpack(words(o.cr)[0]); console.log(`  leaf ${index}: deposit ${v} of token ${token} (public)`); continue; }
    const n = N.decryptAuditor(K.auditor.ask, N.decompressPoint(words(o.epk)[0]), words(o.ca), cm);
    const name = (pk) => names.get(hex(pk[0])) ?? `unregistered ${hex(pk[0]).slice(0, 10)}…`;
    console.log(`  leaf ${index}: → ${name(n.pk)} ${n.v} of token ${n.token}${n.valid ? "" : "  (DOES NOT MATCH THE COMMITMENT)"}  (sender: named in the signed action)`);
  }
} else if (cmd === "recover") {
  // the committee returns an account's shielded key from its committee copy, after the owner
  // proves they own the account (out of band); prints the secret for the owner's key file
  const account = process.argv[3];
  const b = (await post("get_table_rows", { code: CONTRACT, scope: CONTRACT, table: "backups", json: true, limit: 1, lower_bound: account, upper_bound: account })).rows[0];
  if (!b || b.owner !== account || !b.committee) { console.log(`${account}: no committee copy on chain`); process.exit(1); }
  const [w, c] = words(b.committee);
  const ask = N.openSealed(K.auditor.ask, N.decompressPoint(w), c);
  const reg = (await post("get_table_rows", { code: CONTRACT, scope: CONTRACT, table: "keys", json: true, limit: 1, lower_bound: account, upper_bound: account })).rows[0];
  const pk = N.keygen(ask).pk;
  const matches = reg && reg.pubkey === hex(pk[0]) + hex(pk[1]);
  console.log(`${account}: committee copy opens to a key that ${matches ? "MATCHES" : "DOES NOT MATCH"} the registration`);
  if (matches) console.log(JSON.stringify({ format: "pulse-privacy/shieldkey/v1", account, network: "xpr-testnet", secret: "0x" + hex(ask) }, null, 2));
} else {
  console.log("commands: keys | setup | reset | deposit <who> <amt> | finish <who> | scan <who> | send <from> <to> <amt> | withdraw <who> <amt> | audit | recover <account>");
}
process.exit(0); // snarkjs leaves worker threads alive
