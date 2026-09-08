#!/usr/bin/env node
// Private XPR headless client: the whole life cycle from a terminal, no browser and no wallet
// popup. Chain writes are signed by the proton CLI keychain (the account's XPR key never enters
// this process); the private-payment key lives in ~/.private-xpr/<network>/<account>.json.
//
//   privatexpr [--network testnet|mainnet] <command> …      (default network: testnet)
//
//   keys new <account>                 make a key for the account (file mode 600)
//   keys import <account> <secret|file> import a key (hex, or a key file / the app's download)
//   keys show <account>                the public half and its fingerprint
//   keys export <account>              print the key file (the secret!) for another device
//   register <account>                 publish the public key on chain (once per account)
//   deposit <account> <amount> [XPR|XMD]   transfer with the note memo, then place it
//   finish <account>                   place a deposit that arrived but was never placed
//   balance <account>                  notes and balance, with the two-node confirmation state
//   send <from> <to> <amount> [XPR|XMD]    a private payment (receiver and amount hidden)
//   withdraw <account> <amount> [XPR|XMD]  to the account's own public balance
//   activity <account>                 what happened, verified against chain blocks
//   backup phrase <account> [words…]   store the phrase copy (prints a generated phrase if none given)
//   backup committee <account>         store the copy sealed to the committee's key
//   restore <account> <words…>         recover the key from the phrase copy on chain
//   audit                              the committee's view (PRIVATEXPR_AUDITOR_KEY=<key file>)
//   recover <account>                  the committee returns an account's key from its committee copy
//
// --force sends a payment even when the balance is unconfirmed (one node, or nodes disagree).
import { readFileSync } from "node:fs";
import N from "../circuits/lib/notes.mjs";
import { Net, hex, words } from "./lib/net.mjs";
import { act, keyPath, loadKey, parseSecret, saveKey } from "./lib/wallet.mjs";
import { committeeCopy, generatePhrase, openCommitteeCopy, openPhraseCopy, passphraseProblem, phraseCopy } from "./lib/backup.mjs";
import { pick, proveSpend } from "./lib/prove.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const has = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const network = flag("--network") ?? process.env.PRIVATEXPR_NETWORK ?? "testnet";
const force = has("--force");
const [cmd, ...args] = argv;
const net = new Net(network);
await N.init();

const NAME = /^[a-z1-5.]{1,12}$/;
const account = (s) => { if (!NAME.test(s ?? "")) throw new Error(`not an account name: ${s}`); return s; };
const tokenOf = (code = "XPR") => { const t = net.tokens[code.toUpperCase()]; if (!t) throw new Error(`unknown token ${code}`); return { code: code.toUpperCase(), ...t }; };
const units = (x, t) => { if (!/^\d+(\.\d+)?$/.test(String(x))) throw new Error(`not an amount: ${x}`); const [i, f = ""] = String(x).split("."); if (f.length > t.precision) throw new Error(`${t.code} has ${t.precision} decimals`); return BigInt(i) * 10n ** BigInt(t.precision) + BigInt((f + "0".repeat(t.precision)).slice(0, t.precision)); };
const fmt = (u, t) => { const s = u.toString().padStart(t.precision + 1, "0"); return `${s.slice(0, -t.precision)}.${s.slice(-t.precision)} ${t.code}`; };
const tokenById = (id) => Object.entries(net.tokens).map(([code, t]) => ({ code, ...t })).find((t) => t.id === id) ?? { code: `token#${id}`, precision: 0, id };
const fingerprint = (pk) => hex(pk[1]).slice(0, 4) + "·" + hex(pk[1]).slice(-4);
const link = (id) => `${net.explorer}/transaction/${id}`;
const say = (...a) => console.log(...a);

async function registeredOrThrow(name) {
  const keys = await net.registeredKeys();
  const pk = keys.get(name);
  if (!pk) throw new Error(`${name} has not registered a key on ${net.contract}`);
  return pk;
}
function checkKeyMatches(name, k, pk) {
  if (k.pk[0] !== pk[0] || k.pk[1] !== pk[1]) throw new Error(`the key file for ${name} is not the key registered on chain (${fingerprint(pk)}); restore the registered key`);
}
async function balanceOf(name, k) {
  const sc = await net.scan(k);
  if (!sc.confirmed && !force) say(`note: balance unconfirmed (${sc.reasons.join("; ")}); --force to act on it anyway`);
  return sc;
}
async function hasBalanceRow(name, t) {
  const r = await net.rpc("get_table_rows", { code: t.contract, scope: name, table: "accounts", json: true, limit: 50 });
  return r.rows.some((row) => String(row.balance).endsWith(" " + t.code));
}

try {
  if (cmd === "keys") {
    const [sub, name, secret] = args;
    if (sub === "new") {
      const ask = N.randScalar();
      const p = saveKey(network, account(name), ask);
      say(`key for ${name} on ${network} saved to ${p} (fingerprint ${fingerprint(N.keygen(ask).pk)}); next: register ${name}`);
    } else if (sub === "import") {
      const ask = parseSecret(secret ?? "");
      const p = saveKey(network, account(name), ask);
      say(`key for ${name} saved to ${p} (fingerprint ${fingerprint(N.keygen(ask).pk)})`);
    } else if (sub === "show") {
      const k = loadKey(network, account(name));
      const reg = (await net.registeredKeys()).get(name);
      say(`${name}: public key ${hex(k.pk[0])}${hex(k.pk[1])}\nfingerprint ${fingerprint(k.pk)}; on chain: ${reg ? (reg[0] === k.pk[0] && reg[1] === k.pk[1] ? "registered with this key" : `registered with ANOTHER key (${fingerprint(reg)})`) : "not registered"}`);
    } else if (sub === "export") {
      say(readFileSync(keyPath(network, account(name)), "utf8"));
    } else throw new Error("keys new|import|show|export <account>");
  } else if (cmd === "register") {
    const name = account(args[0]);
    const k = loadKey(network, name);
    const reg = (await net.registeredKeys()).get(name);
    if (reg) { checkKeyMatches(name, k, reg); say(`${name} is already registered with this key`); }
    else {
      const r = act(net, net.contract, "register", { owner: name, pubkey: hex(k.pk[0]) + hex(k.pk[1]) }, name);
      say(`registered ${name}: ${link(r.id)}`);
    }
  } else if (cmd === "deposit") {
    const [name0, amt, code] = args;
    const name = account(name0);
    const k = loadKey(network, name);
    checkKeyMatches(name, k, await registeredOrThrow(name));
    const t = tokenOf(code);
    const v = units(amt, t);
    const slots = await net.tableAny("credits");
    const slot = slots.find((c) => c.owner === name);
    if (slot && BigInt(slot.amount) > 0n) throw new Error("a deposit is waiting to be placed: run `finish` first");
    if (!slot) { act(net, net.contract, "open", { owner: name }, name); say("deposit slot opened"); }
    const note = N.newNote(k.pk, v, t.id);
    const r1 = act(net, t.contract, "transfer", { from: name, to: net.contract, quantity: fmt(v, t), memo: `shield:${hex(note.r)}` }, name);
    say(`arrived: ${link(r1.id)}`);
    const r2 = act(net, net.contract, "deposit", { owner: name, r: hex(note.r) }, name);
    say(`placed as a note: ${link(r2.id)} (${r2.cpu ?? "?"} µs)`);
  } else if (cmd === "finish") {
    const name = account(args[0]);
    const slot = (await net.tableAny("credits")).find((c) => c.owner === name);
    if (!slot || BigInt(slot.amount) === 0n) { say("nothing waiting"); }
    else { const r = act(net, net.contract, "deposit", { owner: name, r: slot.r }, name); say(`placed: ${link(r.id)}`); }
  } else if (cmd === "balance") {
    const name = account(args[0]);
    const k = loadKey(network, name);
    const reg = (await net.registeredKeys()).get(name);
    if (reg) checkKeyMatches(name, k, reg);
    const sc = await balanceOf(name, k);
    const totals = new Map();
    for (const n of sc.notes) totals.set(n.token, (totals.get(n.token) ?? 0n) + n.v);
    say(`${name} on ${network}${sc.confirmed ? "" : " (UNCONFIRMED)"}: ${[...totals].map(([id, v]) => fmt(v, tokenById(id))).join(", ") || "0"}`);
    for (const n of sc.notes.sort((a, b) => b.index - a.index)) say(`  note ${n.index}: ${fmt(n.v, tokenById(n.token))} (${n.kind}, unspent)`);
    if (sc.spent.length) say(`  ${sc.spent.length} spent note(s)`);
  } else if (cmd === "send" || cmd === "withdraw") {
    const isSend = cmd === "send";
    const name = account(args[0]);
    const to = isSend ? account(args[1]) : name;
    const t = tokenOf(isSend ? args[3] : args[2]);
    const v = units(isSend ? args[2] : args[1], t);
    const k = loadKey(network, name);
    checkKeyMatches(name, k, await registeredOrThrow(name));
    const toPk = isSend ? await registeredOrThrow(to) : null;
    const cfg = await net.config();
    if (cfg.paused) throw new Error("the contract is paused");
    const sc = await balanceOf(name, k);
    if (!sc.confirmed && !force) throw new Error("refusing to spend on an unconfirmed balance (use --force to override)");
    const inputs = pick(sc.notes, t.id, v, (u) => fmt(u, t));
    const sum = inputs.reduce((s, n) => s + n.v, 0n);
    const outputs = isSend ? [{ pk: toPk, v }, { pk: k.pk, v: sum - v }] : [{ pk: k.pk, v: 0n }, { pk: k.pk, v: sum - v }];
    if (!isSend && !(await hasBalanceRow(name, t))) { act(net, t.contract, "open", { owner: name, symbol: `${t.precision},${t.code}`, ram_payer: name }, name); say(`opened a ${t.code} balance row for ${name}`); }
    say(`proving (${inputs.length} note${inputs.length > 1 ? "s" : ""} in, change ${fmt(sum - v, t)})…`);
    const { data, ms } = await proveSpend({ keys: k, tree: sc.tree, rootSeq: sc.rootSeq, auditorPk: cfg.auditorPk, owner: name, inputs, outputs, vPub: isSend ? 0n : v, tokenPub: isSend ? 0n : t.id, to: isSend ? 0n : N.nameToU64(name) });
    say(`proof in ${(ms / 1000).toFixed(1)} s`);
    const r = act(net, net.contract, "spend", data, name);
    say(isSend ? `paid ${to} ${fmt(v, t)} (the chain shows only that ${name} paid): ${link(r.id)} (${r.cpu ?? "?"} µs)` : `withdrew ${fmt(v, t)} to ${name}: ${link(r.id)} (${r.cpu ?? "?"} µs)`);
  } else if (cmd === "activity") {
    const name = account(args[0]);
    const k = loadKey(network, name);
    const sc = await net.scan(k);
    const mine = [...sc.notes, ...sc.spent];
    const byCm = new Map(mine.map((n) => [hex(n.cm), n]));
    const byNf = new Map(mine.map((n) => [hex(N.nullifier(k.nk, n.index)), n]));
    const onChain = new Set(sc.outs.map((o) => o.cm.toLowerCase()));
    const [deposits, spends] = await Promise.all([net.depositHistory(), net.verifiedSpends((r) => r.cm.some((c) => byCm.has(c)) || r.nf.some((f) => byNf.has(f)), onChain)]);
    const events = [];
    for (const n of mine) if (n.kind === "deposit") { const d = deposits.get(`${name}|${hex(n.r)}`); events.push({ ts: d?.ts ?? "", what: `deposited ${fmt(n.v, tokenById(n.token))}`, trx: d?.trx }); }
    const seen = new Set();
    for (const sp of spends ?? []) {
      const created = sp.cm.map((c) => byCm.get(c)).filter(Boolean);
      const spent = sp.nf.map((f) => byNf.get(f)).filter(Boolean);
      if (sp.owner !== name) { for (const n of created) { events.push({ ts: sp.ts, what: `received ${fmt(n.v, tokenById(n.token))} from ${sp.owner}`, trx: sp.trx }); seen.add(n.index); } continue; }
      if (!spent.length && !created.length) continue;
      const sumIn = spent.reduce((a, n) => a + n.v, 0n), change = created.reduce((a, n) => a + n.v, 0n);
      const t = tokenById(spent[0]?.token ?? created[0]?.token ?? 0n);
      created.forEach((n) => seen.add(n.index));
      if (sp.amount > 0n) events.push({ ts: sp.ts, what: `withdrew ${fmt(sp.amount, tokenById(sp.tokenId || t.id))} to ${name}`, trx: sp.trx });
      const sent = sumIn - change - sp.amount;
      if (sent > 0n) events.push({ ts: sp.ts, what: `sent ${fmt(sent, t)} (receiver known only to you; change ${fmt(change, t)})`, trx: sp.trx });
    }
    for (const n of mine) if (n.kind !== "deposit" && !seen.has(n.index)) events.push({ ts: "", what: `received ${fmt(n.v, tokenById(n.token))} (payer not yet in history)` });
    if (spends === null) say("(no history node answered: times and payers missing)");
    for (const e of events.sort((a, b) => (b.ts || "9").localeCompare(a.ts || "9"))) say(`${(e.ts || "unknown time").padEnd(19)}  ${e.what}${e.trx ? `  ${link(e.trx)}` : ""}`);
    if (!events.length) say("nothing yet");
  } else if (cmd === "backup") {
    const [sub, name0, ...rest] = args;
    const name = account(name0);
    const k = loadKey(network, name);
    checkKeyMatches(name, k, await registeredOrThrow(name));
    if (sub === "phrase") {
      let phrase = rest.join(" ").trim();
      const generated = !phrase;
      if (generated) phrase = generatePhrase();
      else { const p = passphraseProblem(phrase); if (p) throw new Error(p); }
      const blob = await phraseCopy(k.ask, phrase);
      const r = act(net, net.contract, "setbackup", { owner: name, phrase: blob, committee: "" }, name);
      say(`phrase copy stored: ${link(r.id)}`);
      if (generated) say(`\nYOUR RECOVERY PHRASE (not stored anywhere else; write it down):\n\n  ${phrase}\n`);
    } else if (sub === "committee") {
      const cfg = await net.config();
      const blob = committeeCopy(k.ask, cfg.auditorPk);
      const r = act(net, net.contract, "setbackup", { owner: name, phrase: "", committee: blob }, name);
      say(`committee copy stored: ${link(r.id)}`);
    } else throw new Error("backup phrase|committee <account>");
  } else if (cmd === "restore") {
    const [name0, ...rest] = args;
    const name = account(name0);
    const phrase = rest.join(" ").trim();
    if (!phrase) throw new Error("restore <account> <the words>");
    const row = (await net.tableAny("backups")).find((b) => b.owner === name);
    if (!row || !row.phrase) throw new Error(`${name} has no phrase copy on chain`);
    const ask = await openPhraseCopy(row.phrase, phrase);
    const reg = await registeredOrThrow(name);
    const k = N.keygen(ask);
    checkKeyMatches(name, k, reg);
    const p = saveKey(network, name, ask, { restored: "from the phrase copy on chain" });
    say(`restored: key for ${name} saved to ${p} (fingerprint ${fingerprint(k.pk)})`);
  } else if (cmd === "audit" || cmd === "recover") {
    const file = process.env.PRIVATEXPR_AUDITOR_KEY;
    if (!file) throw new Error("set PRIVATEXPR_AUDITOR_KEY to the committee's key file");
    const auditorAsk = parseSecret(file);
    const cfg = await net.config();
    const apk = N.keygen(auditorAsk).pk;
    if (apk[0] !== cfg.auditorPk[0] || apk[1] !== cfg.auditorPk[1]) throw new Error("that key is not the auditor key configured on the contract");
    if (cmd === "recover") {
      const name = account(args[0]);
      const row = (await net.tableAny("backups")).find((b) => b.owner === name);
      if (!row || !row.committee) throw new Error(`${name} has no committee copy on chain`);
      const ask = openCommitteeCopy(row.committee, auditorAsk);
      const reg = await registeredOrThrow(name);
      const k = N.keygen(ask);
      checkKeyMatches(name, k, reg);
      say(`${name}: the committee copy opens to the registered key. Hand this key file to the account's owner over a channel you trust:\n`);
      say(JSON.stringify({ format: "pulse-privacy/shieldkey/v1", account: name, network: `xpr-${network}`, secret: "0x" + hex(ask) }, null, 2));
    } else {
      const names = new Map([...(await net.registeredKeys())].map(([n, pk]) => [hex(pk[0]) + hex(pk[1]), n]));
      const t = await net.scanTables();
      // when and where: spends from history confirmed against their blocks, deposits from the contract's deposit actions
      const spendsBy = new Map();
      for (const sp of (await net.verifiedSpends(() => true, new Set(t.outs.map((o) => o.cm.toLowerCase())))) ?? []) for (const c of sp.cm) spendsBy.set(c, sp);
      const deposits = await net.depositHistory();
      const when = (rec) => (rec ? `${rec.ts.replace("T", " ").slice(0, 19)} UTC  block ${rec.block}  tx ${rec.trx.slice(0, 12)}…` : "time and block not in history yet");
      say(`${net.contract} on ${network}: ${t.nextLeaf} leaves, ${t.spent.size} spend tags${t.confirmed ? "" : " (UNCONFIRMED: " + t.reasons.join("; ") + ")"}`);
      for (const o of t.outs.sort((a, b) => Number(a.index) - Number(b.index))) {
        const cm = BigInt("0x" + o.cm);
        if (!o.epk) {
          const [packed, r] = words(o.cr); const [v, token] = N.unpack(packed);
          let to = "unknown"; for (const [pkHex, n] of names) { const pk = words(pkHex); if (N.commitment({ pk, v, token, r }) === cm) { to = n; break; } }
          say(`  leaf ${o.index}: deposit by ${to}: ${fmt(v, tokenById(token))}\n           ${when(deposits.get(`${to}|${hex(r)}`))}`);
          continue;
        }
        const n = N.decryptAuditor(auditorAsk, N.decompressPoint(words(o.epk)[0]), words(o.ca), cm);
        const to = n ? (names.get(hex(n.pk[0]) + hex(n.pk[1])) ?? `unregistered ${fingerprint(n.pk)}`) : "unreadable";
        const sp = spendsBy.get(o.cm.toLowerCase());
        say(`  leaf ${o.index}: ${sp?.owner ?? "unknown"} → ${to}: ${n ? fmt(n.v, tokenById(n.token)) : "?"}${n && !n.valid ? "  (DOES NOT MATCH THE COMMITMENT)" : ""}${sp && sp.amount > 0n ? `  (with a withdrawal of ${fmt(sp.amount, tokenById(sp.tokenId))} to ${sp.owner})` : ""}\n           ${when(sp)}`);
      }
    }
  } else {
    say(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
process.exit(); // snarkjs leaves worker threads alive
