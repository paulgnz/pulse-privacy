#!/usr/bin/env node
// Auditor CLI (T5): with the viewing key, read every confidential transfer on the chain,
// decrypt the amounts, and reconcile the pool.
//
//   node auditor.mjs ledger      [--from BLOCK]   every send/deposit/withdraw, decrypted
//   node auditor.mjs reconcile                     per-account balances from the ledger vs on-chain
//                                                  ciphertexts (owner handle can't be opened by the
//                                                  auditor, so balances are reconstructed by summing)
//                                                  and Σ(deposits − withdrawals) vs the escrow
//   node auditor.mjs account NAME                  one account's history
//
// Env: AUDITOR_SECRET (hex/decimal scalar) or AUDITOR_KEYFILE (JSON with {"auditor": "..."}),
//      HYPERION (default https://test.proton.eosusa.io), RPC (default https://tn1.protonnz.com),
//      CONTRACT (default xprconf), SYMBOL (default XPR), PRECISION (default 4)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import eg from "../../circuits/lib/elgamal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HYPERION = process.env.HYPERION ?? "https://test.proton.eosusa.io";
const RPC = process.env.RPC ?? "https://tn1.protonnz.com";
const CONTRACT = process.env.CONTRACT ?? "xprconf";
const SYMBOL = process.env.SYMBOL ?? "XPR";
const PRECISION = Number(process.env.PRECISION ?? 4);
const TOKEN = process.env.TOKEN_CONTRACT ?? "eosio.token";
const SYM_STR = `${PRECISION},${SYMBOL}`; // e.g. "4,XPR": the contract scopes everything by token

const [cmd, arg] = process.argv.slice(2);
const fromArg = process.argv.indexOf("--from");
let FROM_BLOCK = fromArg > -1 ? Number(process.argv[fromArg + 1]) : 0;

const fmt = (u) => (Number(u) / 10 ** PRECISION).toFixed(PRECISION) + " " + SYMBOL;
const units = (assetStr) => BigInt(Math.round(parseFloat(assetStr) * 10 ** PRECISION));

function loadSecret() {
  if (process.env.AUDITOR_SECRET) return BigInt(process.env.AUDITOR_SECRET);
  const f = process.env.AUDITOR_KEYFILE ?? join(HERE, "../../contracts/xpr-conf-tsc/tests/.testnet-keys.json");
  const j = JSON.parse(readFileSync(f, "utf8"));
  const v = j.auditor ?? j.secret;
  if (v === undefined) throw new Error("key file has neither \"auditor\" nor \"secret\"");
  return BigInt(v);
}

async function getActions() {
  const out = [];
  let skip = 0;
  for (;;) {
    const url = `${HYPERION}/v2/history/get_actions?account=${CONTRACT}&limit=100&skip=${skip}&sort=asc${FROM_BLOCK ? `&after=${FROM_BLOCK}` : ""}`;
    const d = await (await fetch(url)).json();
    const acts = d.actions ?? [];
    out.push(...acts);
    if (acts.length < 100) break;
    skip += 100;
  }
  return out;
}

async function escrowBalance() {
  const r = await (await fetch(`${RPC}/v1/chain/get_currency_balance`, { method: "POST", body: JSON.stringify({ code: TOKEN, account: CONTRACT, symbol: SYMBOL }) })).json();
  return r[0] ? units(r[0]) : 0n;
}

async function preCodeInflow() {
  if (!FROM_BLOCK) return 0n;
  const d = await (await fetch(`${HYPERION}/v2/history/get_actions?account=${CONTRACT}&filter=${TOKEN}:transfer&limit=500&sort=asc&before=${FROM_BLOCK}`)).json();
  let s = 0n;
  for (const a of d.actions ?? []) {
    if (a.act.data.to === CONTRACT) s += units(a.act.data.quantity);
    if (a.act.data.from === CONTRACT) s -= units(a.act.data.quantity);
  }
  return s;
}

async function accountRows() {
  let raw = BigInt(PRECISION);
  for (let i = 0; i < SYMBOL.length; i++) raw |= BigInt(SYMBOL.charCodeAt(i)) << BigInt(8 * (i + 1));
  const r = await (await fetch(`${RPC}/v1/chain/get_table_rows`, { method: "POST", body: JSON.stringify({ code: CONTRACT, scope: raw.toString(), table: "accounts", limit: 1000, json: true }) })).json();
  return r.rows ?? [];
}

// Default start: the block where the confidential contract FIRST went live (later redeploys
// keep earlier claims valid). Override with --from or START_BLOCK. Transfers into the account
// before that block carry no claim (the testnet has 8,000 XPR of those).
const START_BLOCK = Number(process.env.START_BLOCK ?? (CONTRACT === "xprconf" ? 404503797 : 0));
if (!FROM_BLOCK) FROM_BLOCK = START_BLOCK;

await eg.init();
const secret = loadSecret();
const auditor = eg.keygen(secret);

// Build the ledger: one entry per economic event, deduplicated by (trx, action ordinal).
const seen = new Set();
const ledger = [];
for (const a of await getActions()) {
  const key = `${a.trx_id}:${a.action_ordinal ?? a.global_sequence}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const act = a.act;
  const base = { block: a.block_num, time: a.timestamp, tx: a.trx_id };
  const symOf = (d) => (d && d.sym !== undefined ? String(d.sym) : (d && d.quantity ? `${PRECISION},${String(d.quantity).split(" ")[1]}` : null));
  if (act.account === CONTRACT && ["send", "withdraw", "register", "applypending"].includes(act.name) && symOf(act.data) !== SYM_STR) continue; // another token
  if (act.account === CONTRACT && act.name === "send") {
    const t = act.data.t;
    let amount = null;
    try { amount = eg.decrypt64(eg.tAuditorFromHex(t), auditor.s); } catch (e) { amount = null; }
    ledger.push({ ...base, kind: "send", from: act.data.from, to: act.data.to, amount, ciphertext: t.slice(0, 16) + "…" });
  } else if (act.account === TOKEN && act.name === "transfer" && act.data.to === CONTRACT) {
    const memo = String(act.data.memo ?? "");
    const owner = memo.startsWith("conf:") ? memo.slice(5) : null;
    ledger.push({ ...base, kind: owner ? "deposit" : "plain-transfer-in", from: act.data.from, to: owner ?? CONTRACT, amount: units(act.data.quantity) });
  } else if (act.account === CONTRACT && act.name === "withdraw") {
    ledger.push({ ...base, kind: "withdraw", from: act.data.owner, to: act.data.owner, amount: units(act.data.quantity) });
  } else if (act.account === CONTRACT && act.name === "register") {
    ledger.push({ ...base, kind: "register", from: act.data.owner, to: act.data.owner, amount: null });
  }
}

const line = (e) =>
  `${String(e.block).padStart(10)}  ${e.time.slice(0, 19)}  ${e.kind.padEnd(18)} ${String(e.from).padEnd(13)} → ${String(e.to).padEnd(13)} ${e.amount === null ? (e.kind === "send" ? "UNREADABLE" : "") : fmt(e.amount)}${e.ciphertext ? "   " + e.ciphertext : ""}`;

if (cmd === "ledger") {
  console.log(`auditor ledger · ${CONTRACT} on ${HYPERION} · from block ${FROM_BLOCK} (contract start) · viewing pubkey ${eg.ptHex(auditor.P).slice(0, 16)}…`);
  for (const e of ledger) console.log(line(e));
  console.log(`${ledger.length} events`);
} else if (cmd === "account") {
  const n = arg;
  for (const e of ledger) if (e.from === n || e.to === n) console.log(line(e));
} else if (cmd === "reconcile") {
  const bal = {};
  let deposits = 0n, withdrawals = 0n, stray = 0n, unreadable = 0;
  for (const e of ledger) {
    if (e.kind === "deposit") { bal[e.to] = (bal[e.to] ?? 0n) + e.amount; deposits += e.amount; }
    else if (e.kind === "withdraw") { bal[e.from] = (bal[e.from] ?? 0n) - e.amount; withdrawals += e.amount; }
    else if (e.kind === "send") {
      if (e.amount === null) { unreadable++; continue; }
      bal[e.from] = (bal[e.from] ?? 0n) - e.amount; bal[e.to] = (bal[e.to] ?? 0n) + e.amount;
    } else if (e.kind === "plain-transfer-in") stray += e.amount;
  }
  const rows = await accountRows();
  console.log(`ledger from block ${FROM_BLOCK} (contract start); earlier transfers into the account carry no claim\n`);
  console.log("account        reconstructed balance (deposits − withdrawals + received − sent)   on-chain nonce  pending_count");
  for (const r of rows) console.log(`${r.owner.padEnd(14)} ${fmt(bal[r.owner] ?? 0n).padStart(24)}   ${String(r.nonce).padStart(14)}  ${String(r.pending_count).padStart(13)}`);
  const sum = Object.values(bal).reduce((a, b) => a + b, 0n);
  const escrow = await escrowBalance();
  console.log(`\nΣ reconstructed balances : ${fmt(sum)}`);
  console.log(`deposits − withdrawals   : ${fmt(deposits - withdrawals)}`);
  console.log(`escrow (${TOKEN})       : ${fmt(escrow)}`);
  console.log(`stray transfers in       : ${fmt(stray)} (no confidential claim)`);
  console.log(`unreadable sends         : ${unreadable}`);
  // escrow may also hold pre-code transfers (before FROM_BLOCK); they carry no claim
  const pre = await preCodeInflow();
  console.log(`pre-code transfers in    : ${fmt(pre)} (before block ${FROM_BLOCK}, no claim)`);
  const ok = escrow === deposits - withdrawals + stray + pre && sum === deposits - withdrawals;
  console.log(ok ? "\nRECONCILED: escrow = deposits − withdrawals + stray; balances sum to the pool" : "\nMISMATCH");
  process.exitCode = ok ? 0 : 2;
} else {
  console.log("usage: auditor.mjs ledger [--from BLOCK] | reconcile | account NAME");
}
