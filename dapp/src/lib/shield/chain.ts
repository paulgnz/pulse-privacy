// The shielded contract (xprshield) from the browser: table reads, note scanning, the tree,
// proving, and the actions the wallet signs. Every chain write is a wallet transaction of the
// sender; the proof hides the receiver, the amount and the notes spent (docs/06 §8).
import * as snarkjs from "snarkjs";
import { ENDPOINTS, EXPLORER, HYPERIONS, SHIELD } from "../../config";
import type { Session } from "../chain";
import type { Pt } from "../crypto/babyjub";
import { ptHex, w32 } from "../crypto/babyjub";
import type { Token } from "../token";
import { TOKEN_IDS, Tree, buildJoinSplit, commitment, decompressPoint, decryptAuditor, hex32, nameToU64, newNote, nullifier, treeOf, tryDecryptReceiver, unpack, words } from "./notes";
import type { OwnedNote, ShieldKeys } from "./notes";

const WASM = "/circuit/joinsplit-r6.wasm";
const ZKEY = "/circuit/joinsplit-r6_final.zkey";

// Testnet nodes fall behind each other by minutes at times: order the endpoints by head block,
// probed once per few minutes, so table reads come from the freshest node.
let ordered: { at: number; list: string[] } | null = null;
async function endpoints(): Promise<string[]> {
  if (ordered && Date.now() - ordered.at < 180000) return ordered.list;
  const heads = await Promise.all(ENDPOINTS.map(async (ep) => {
    try {
      const r = await fetch(`${ep}/v1/chain/get_info`, { signal: AbortSignal.timeout(4000) });
      const j = (await r.json()) as { head_block_num: number };
      return { ep, head: j.head_block_num };
    } catch { return { ep, head: -1 }; }
  }));
  const list = heads.sort((a, b) => b.head - a.head).map((h) => h.ep);
  ordered = { at: Date.now(), list };
  return list;
}

async function rpc<T>(path: string, body: unknown): Promise<T> {
  let lastErr: unknown;
  for (const ep of await endpoints()) {
    try {
      const res = await fetch(`${ep}/v1/chain/${path}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function rows<T extends Record<string, unknown>>(table: string, key: string, endpoint?: string): Promise<T[]> {
  const out: T[] = [];
  let lower: string | undefined;
  for (;;) {
    const body = { code: SHIELD.contract, scope: SHIELD.contract, table, json: true, limit: 1000, lower_bound: lower };
    const r = endpoint
      ? await (async () => {
          const res = await fetch(`${endpoint}/v1/chain/get_table_rows`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json() as { rows: T[]; more: boolean; next_key?: string };
        })()
      : await rpc<{ rows: T[]; more: boolean; next_key?: string }>("get_table_rows", body);
    out.push(...r.rows);
    if (!r.more) return out;
    if (r.rows.length === 0) throw new Error(`${table}: incomplete page`);
    const next = (r as { next_key?: string }).next_key;
    if (next) {
      if (lower !== undefined && BigInt(next) <= BigInt(lower)) throw new Error(`${table}: pagination did not advance`);
      lower = next;
      continue;
    }
    const last = r.rows[r.rows.length - 1][key];
    const lastKey = typeof last === "string" && !/^\d+$/.test(last) ? nameToU64(last) : BigInt(String(last));
    const following = lastKey + 1n;
    if (lower !== undefined && following <= BigInt(lower)) throw new Error(`${table}: pagination did not advance`);
    lower = following.toString();
  }
}

export interface ShieldConfig { auditorPk: Pt; paused: boolean; tokens: { token: Token; id: bigint; contract: string; maxPool: bigint; maxDeposit: bigint; pool: bigint }[] }

/** the config row as at least two nodes report it, and as this build expects it */
async function agreedConfig(): Promise<{ auditor_pubkey: string; paused: boolean } | null> {
  const answers = await Promise.allSettled([...new Set(ENDPOINTS)].map(async (ep) => {
    const res = await fetch(`${ep}/v1/chain/get_table_rows`, { method: "POST", body: JSON.stringify({ code: SHIELD.contract, scope: SHIELD.contract, table: "config", json: true, limit: 1 }), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { rows: { auditor_pubkey: string; paused: number | boolean }[] };
    if (!j.rows.length) return null;
    if (!/^[0-9a-f]{128}$/i.test(j.rows[0].auditor_pubkey)) throw new Error("malformed config");
    return { auditor_pubkey: j.rows[0].auditor_pubkey.toLowerCase(), paused: !!j.rows[0].paused };
  }));
  const got = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  if (got.length < 2) throw new Error("Cannot confirm the contract's configuration with two independent servers. Try again shortly.");
  if (got.every((g) => g === null)) return null;
  const rows = got.filter((g): g is { auditor_pubkey: string; paused: boolean } => !!g);
  const agreed = rows.find((r) => rows.filter((o) => o.auditor_pubkey === r.auditor_pubkey).length >= 2);
  if (!agreed) throw new Error("The servers disagree about the contract's auditor key. Try again shortly.");
  if (SHIELD.auditorPk && agreed.auditor_pubkey !== SHIELD.auditorPk.toLowerCase()) throw new Error("The auditor key on chain is not the committee key this app was built with. Refusing to continue; contact the operator.");
  return { auditor_pubkey: agreed.auditor_pubkey, paused: rows.some((r) => r.paused) };
}

export async function getConfig(knownTokens: Token[]): Promise<ShieldConfig | null> {
  const row = await agreedConfig();
  if (!row) return null;
  const c = { rows: [row] };
  const a = words(c.rows[0].auditor_pubkey);
  // the token table's identity fields (symbol, issuing contract, token id) must be agreed by two
  // nodes and must match the ids this build was made with; a node that relabels a token could
  // otherwise turn "1 XMD" into a note of a hundred XPR. Caps and pool counters may lag a block
  // between nodes and are taken from the agreed row's first copy.
  type TokRow = { sym: string | number; token_contract: string; token_id: string | number; max_pool: string | number; max_deposit: string | number; pool: string | number };
  const identity = (r: TokRow) => `${BigInt(r.sym)}|${r.token_contract}|${BigInt(r.token_id)}`;
  // each node's answer is validated on its own; a malformed answer is dropped, not fatal
  const answers = await Promise.allSettled([...new Set(ENDPOINTS)].map(async (ep) => {
    const list = await rows<TokRow>("tokens", "sym", ep);
    for (const r of list) { identity(r); BigInt(r.max_pool); BigInt(r.max_deposit); BigInt(r.pool); if (!/^[a-z1-5.]{1,12}$/.test(r.token_contract)) throw new Error("malformed token row"); }
    return list;
  }));
  const lists = answers.flatMap((x) => (x.status === "fulfilled" ? [x.value] : []));
  if (lists.length < 2) throw new Error("Cannot confirm the contract's token list with two independent servers. Try again shortly.");
  const agreedRows = new Map<string, TokRow>();
  for (const l of lists) for (const r of l) {
    const id = identity(r);
    if (agreedRows.has(id)) continue;
    if (lists.filter((o) => o.some((x) => identity(x) === id)).length >= 2) agreedRows.set(id, r);
  }
  const tokens = [...agreedRows.values()].flatMap((row) => {
    const raw = BigInt(row.sym);
    const precision = Number(raw & 0xffn);
    let code = "";
    for (let i = 1; i < 8; i++) { const ch = Number((raw >> BigInt(8 * i)) & 0xffn); if (ch) code += String.fromCharCode(ch); }
    const known = knownTokens.find((k) => k.code === code);
    const id = BigInt(row.token_id);
    if (known && (known.precision !== precision || known.contract !== row.token_contract)) throw new Error(`The contract's ${code} does not match this app's ${code}. Refusing to continue.`);
    if (TOKEN_IDS[code] !== undefined && TOKEN_IDS[code] !== id) throw new Error(`The contract's token id for ${code} is not the one this app was built with. Refusing to continue.`);
    const token = known ?? ({ code, precision, contract: row.token_contract } as Token);
    return [{ token, id, contract: row.token_contract, maxPool: BigInt(row.max_pool), maxDeposit: BigInt(row.max_deposit), pool: BigInt(row.pool) }];
  });
  return { auditorPk: [a[0], a[1]], paused: !!c.rows[0].paused, tokens };
}

/**
 * Every account with a shielded key, with the keys, fetched as one table read (cached briefly).
 * Recipients are resolved from this locally, so a name is never sent to a node on its own.
 */
let keysCache: { at: number; map: Map<string, Pt> } | null = null;
export async function registeredKeys(): Promise<Map<string, Pt>> {
  if (keysCache && Date.now() - keysCache.at < 60000) return keysCache.map;
  // Each vote is a complete table from a distinct configured server. Cached data from a
  // single server is never an independent vote, and no request contains the recipient.
  const answers = await Promise.allSettled([...new Set(ENDPOINTS)].map(async (ep) => {
    const table = await rows<{ owner: string; pubkey: string }>("keys", "owner", ep);
    const map = new Map<string, string>();
    for (const row of table) {
      if (!/^[a-z1-5.]{1,12}$/.test(row.owner) || !/^[0-9a-f]{128}$/i.test(row.pubkey) || map.has(row.owner)) throw new Error("Malformed shielded key table");
      map.set(row.owner, row.pubkey.toLowerCase());
    }
    return map;
  }));
  const tables = answers.flatMap((a) => a.status === "fulfilled" ? [a.value] : []);
  if (tables.length < 2) throw new Error("Cannot confirm shielded keys with two independent servers. Try again shortly.");
  const map = new Map<string, Pt>();
  for (const table of tables) for (const [owner, pubkey] of table) {
    if (tables.filter((t) => t.get(owner) === pubkey).length >= 2) {
      const w = words(pubkey);
      map.set(owner, [w[0], w[1]]);
    }
  }
  keysCache = { at: Date.now(), map };
  return map;
}
export async function registeredNames(): Promise<string[]> {
  return [...(await registeredKeys()).keys()].sort();
}

/**
 * Only use keys confirmed by two distinct servers. Resolve locally so sending does not
 * reveal the recipient's name to an RPC server.
 */
export async function registeredKey(actor: string): Promise<Pt | null> {
  return (await registeredKeys()).get(actor) ?? null;
}

/** a short fingerprint of a key, shown next to the recipient so a wrong key is visible */
export const keyFingerprint = (pk: Pt) => hex32(pk[1]).slice(0, 4) + "·" + hex32(pk[1]).slice(-4);

/** the tree row (root, next_leaf, root_seq) that at least two nodes agree on; `confirmed` false when only one answered */
export interface TreeRowAgreed { id: number; next: number; root: string; rootSeq: bigint }
/**
 * Every tree row (root, next_leaf, root_seq per tree) as two nodes agree on them, plus the
 * active tree from the config row; `confirmed` false when only one node answered. Each node's
 * answer is validated on its own before agreement.
 */
async function agreedTrees(): Promise<{ trees: TreeRowAgreed[]; active: number; confirmed: boolean }> {
  const answers = await Promise.allSettled([...new Set(ENDPOINTS)].map(async (ep) => {
    const list = await rows<{ id: string | number; next_leaf: string | number; root: string; root_seq: string | number }>("tree", "id", ep);
    const trees = list.map((r) => ({ id: Number(r.id), next: Number(r.next_leaf), root: String(r.root).toLowerCase(), rootSeq: BigInt(r.root_seq) }));
    for (const t of trees) if (!Number.isInteger(t.id) || t.id < 0 || t.id >= 1 << 24 || t.rootSeq < 0n || t.rootSeq > 1n << 40n || !Number.isInteger(t.next) || t.next < 0 || t.next > 1 << 20 || !/^[0-9a-f]{64}$/.test(t.root)) throw new Error("malformed tree row");
    if (new Set(trees.map((t) => t.id)).size !== trees.length) throw new Error("duplicate tree rows");
    const cres = await fetch(`${ep}/v1/chain/get_table_rows`, { method: "POST", body: JSON.stringify({ code: SHIELD.contract, scope: SHIELD.contract, table: "config", json: true, limit: 1 }), signal: AbortSignal.timeout(15000) });
    if (!cres.ok) throw new Error(`HTTP ${cres.status}`);
    const cj = (await cres.json()) as { rows: { active_tree?: string | number }[] };
    const active = Number(cj.rows[0]?.active_tree ?? 0);
    if (!trees.length) trees.push({ id: 0, next: 0, root: hex32(new Tree().root), rootSeq: 0n });
    return { trees: trees.sort((a, b) => a.id - b.id), active, key: trees.map((t) => `${t.id}:${t.next}:${t.root}:${t.rootSeq}`).join("|") + `#${active}` };
  }));
  const got = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  if (!got.length) throw new Error("No node answered.");
  // nodes can be a block apart: take the most advanced state that two nodes share; else the single answer, unconfirmed
  const total = (g: typeof got[0]) => g.trees.reduce((n, t) => n + t.next, 0);
  const shared = got.filter((r) => got.filter((o) => o.key === r.key).length >= 2).sort((a, b) => total(b) - total(a));
  if (shared.length) return { trees: shared[0].trees, active: shared[0].active, confirmed: true };
  const best = got.sort((a, b) => total(b) - total(a))[0];
  return { trees: best.trees, active: best.active, confirmed: false };
}

// each rebuilt tree is cached and extended: leaves are append-only, so a later scan hashes only
// what is new. A node's answer is built into a candidate (the cached prefix it agrees with, then
// its own leaves) and only replaces the cache once its root matched, so a lying node can neither
// poison the cache nor throw a verified one away and force the honest node to rebuild from scratch
const treeCaches = new Map<number, { tree: Tree; cms: string[] }>();
function rebuildTo(id: number, next: number, byIndex: Map<number, string>): { tree: Tree; cms: string[] } {
  const cached = treeCaches.get(id) ?? null;
  let keep = 0;
  if (cached) {
    keep = Math.min(cached.cms.length, next);
    for (let i = 0; i < keep; i++) if ((byIndex.get(i) ?? "0".repeat(64)) !== cached.cms[i]) { keep = 0; break; }
  }
  const cand = cached && keep === cached.cms.length ? { tree: cached.tree.snapshot(), cms: cached.cms.slice() } : { tree: new Tree(undefined, id), cms: [] as string[] };
  if (cand.cms.length > keep) { cand.tree = new Tree(undefined, id); cand.cms = []; }
  for (let i = cand.cms.length; i < next; i++) { const cm = byIndex.get(i) ?? "0".repeat(64); cand.tree.append(BigInt("0x" + cm)); cand.cms.push(cm); }
  return cand;
}
/** the outputs of one node grouped by tree and checked against the agreed roots; returns the rebuilt trees or throws */
function rebuildAll(agreed: TreeRowAgreed[], outs: { index: string | number; cm: string }[]): Map<number, Tree> {
  const result = new Map<number, Tree>();
  for (const t of agreed) {
    const byIndex = new Map<number, string>();
    for (const o of outs) {
      const g = Number(o.index);
      if (treeOf(g) !== t.id) continue;
      const pos = g - t.id * 2 ** 20;
      if (!Number.isInteger(pos) || pos < 0) throw new Error("malformed outputs");
      if (pos >= t.next) continue;
      if (byIndex.has(pos) || !/^[0-9a-f]{64}$/i.test(o.cm)) throw new Error("malformed outputs");
      byIndex.set(pos, o.cm.toLowerCase());
    }
    const cand = rebuildTo(t.id, t.next, byIndex);
    if (hex32(cand.tree.root) !== t.root) throw new Error(`outputs of tree ${t.id} do not hash to the agreed root`);
    const prev = treeCaches.get(t.id);
    if (!prev || prev.cms.length <= cand.cms.length) treeCaches.set(t.id, cand);
    result.set(t.id, cand.tree);
  }
  return result;
}

/** every tree rebuilt from the outputs table and checked against the roots two nodes agree on; snapshots, so a payment keeps its root */
export interface ChainTrees { trees: Map<number, { tree: Tree; rootSeq: bigint; next: number }>; active: number; confirmed: boolean }
export async function chainTree(): Promise<ChainTrees> {
  const agreed = await agreedTrees();
  let lastErr: unknown = new Error("No node answered.");
  for (const ep of await endpoints()) {
    try {
      const outs = await rows<{ index: string | number; cm: string }>("outputs", "index", ep);
      const built = rebuildAll(agreed.trees, outs);
      const trees = new Map<number, { tree: Tree; rootSeq: bigint; next: number }>();
      for (const t of agreed.trees) trees.set(t.id, { tree: built.get(t.id)!.snapshot(), rootSeq: t.rootSeq, next: t.next });
      return { trees, active: agreed.active, confirmed: agreed.confirmed };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`The trees read from the chain do not match the contract's roots (${(lastErr as Error).message}); try again.`);
}

export interface ScanResult { notes: OwnedNote[]; spent: OwnedNote[]; confirmed?: boolean }
export type NoteKind = "deposit" | "note";

/** every note of ours, from the outputs, leaves and nullifiers tables; zero-value notes are skipped */
/**
 * The tables a scan needs, from one node, checked against the tree two nodes agree on: only
 * leaves below the agreed next_leaf count, and they must hash to the agreed root, so a node
 * cannot invent a note or a balance. `confirmed` is false when only one node answered.
 */
async function scanTables() {
  const agreedAll = await agreedTrees();
  const agreed = { next: agreedAll.trees.reduce((n, t) => n + t.next, 0), confirmed: agreedAll.confirmed };
  // spent status from every node. A nullifier counts as spent when two nodes list it; one that a
  // single node lists while another omits it is disputed: it is treated as spent (the safe side
  // for spending) and the balance is reported unconfirmed until the nodes agree
  const nfAnswers = await Promise.allSettled([...new Set(ENDPOINTS)].map(async (ep) => {
    const list = await rows<{ key: string | number; nf: string }>("nullifiers", "key", ep);
    const set = new Set<string>();
    for (const n of list) { if (typeof n.nf !== "string" || !/^[0-9a-f]{64}$/i.test(n.nf)) throw new Error("malformed nullifier"); set.add(n.nf.toLowerCase()); }
    return set;
  }));
  const nfLists = nfAnswers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  if (!nfLists.length) throw new Error("No node answered the scan.");
  const nfCount = new Map<string, number>();
  for (const l of nfLists) for (const nf of l) nfCount.set(nf, (nfCount.get(nf) ?? 0) + 1);
  const disputed = nfLists.length >= 2 && [...nfCount.values()].some((c) => c < 2);
  const nfs = [...nfCount.keys()].map((nf) => ({ key: 0, nf }));
  const nfConfirmed = nfLists.length >= 2 && !disputed;
  // the outputs rows from every node. The commitments are the leaves and must hash to the agreed
  // root, which authenticates them; the note data beside them (epk, cr, ca) is not covered by the
  // root, so it is authenticated by agreement: a row two nodes return identically is agreed, a row
  // the nodes disagree on is disputed, every variant is tried, and the balance is unconfirmed
  type Out = { index: string | number; cm: string; epk: string; cr: string; ca: string };
  const outAnswers = await Promise.allSettled([...new Set(ENDPOINTS)].map((ep) => rows<Out>("outputs", "index", ep)));
  const inTree = (o: Out) => { const g = Number(o.index); const t = agreedAll.trees.find((x) => x.id === treeOf(g)); return !!t && g - t.id * 2 ** 20 < t.next; };
  const valid: Out[][] = [];
  for (const a of outAnswers) {
    if (a.status !== "fulfilled") continue;
    try {
      const list = a.value.filter(inTree);
      rebuildAll(agreedAll.trees, list); // throws on a duplicate, a malformed row, or a root mismatch in any tree
      valid.push(list);
    } catch { /* this node's answer is discarded */ }
  }
  if (!valid.length) throw new Error("No node returned outputs that match the agreed roots; try again.");
  // the commitments are authenticated by the root; the note data beside them (epk, cr, ca) is not,
  // so it is authenticated by agreement: a row two nodes return identically is agreed, a disputed
  // row has every variant tried, and any dispute or single-node answer leaves the balance unconfirmed
  const key = (o: Out) => `${o.cm}|${o.epk}|${o.cr}|${o.ca}`.toLowerCase();
  const variants = new Map<number, Map<string, { row: Out; votes: number }>>();
  for (const l of valid) for (const o of l) {
    const i = Number(o.index);
    const m = variants.get(i) ?? new Map<string, { row: Out; votes: number }>();
    const k = key(o);
    const v = m.get(k) ?? { row: o, votes: 0 };
    v.votes += 1;
    m.set(k, v);
    variants.set(i, m);
  }
  const outs: Out[] = [];
  const cms = new Map<number, string>();
  let outsDisputed = valid.length < 2;
  for (const [i, m] of variants) {
    const vs = [...m.values()].sort((a, b) => b.votes - a.votes);
    if (vs.length > 1 || vs[0].votes < 2) outsDisputed = true;
    cms.set(i, vs[0].row.cm.toLowerCase());
    for (const v of vs) outs.push(v.row); // every variant is tried; a note is only ever accepted if it recomputes to its commitment
  }
  return { outs, leaves: [...cms].map(([index, cm]) => ({ index, cm })), nfs, confirmed: agreed.confirmed && nfConfirmed && !outsDisputed, next: agreed.next };
}

export async function scan(keys: ShieldKeys): Promise<ScanResult> {
  const { outs, leaves, nfs, confirmed } = await scanTables();
  const cmOf = new Map(leaves.map((l) => [Number(l.index), BigInt("0x" + l.cm)]));
  const spentSet = new Set(nfs.map((n) => n.nf.toLowerCase()));
  const notes: OwnedNote[] = [];
  const spent: OwnedNote[] = [];
  let skipped = 0;
  for (const o of outs) {
    const index = Number(o.index);
    const cm = cmOf.get(index);
    if (cm === undefined) continue;
    let note = null;
    try {
    if (!o.epk) {
      const [packed, r] = words(o.cr);
      const [v, token] = unpack(packed);
      const cand = { pk: keys.pk, v, token, r, cm: 0n };
      cand.cm = commitment(cand);
      if (cand.cm === cm) note = cand;
    } else {
      note = tryDecryptReceiver(keys, decompressPoint(words(o.epk)[0]), words(o.cr), cm);
    }
    } catch { skipped++; continue; } // one malformed row from a node must not blank the balance
    if (!note || note.v === 0n) continue;
    if (notes.some((n) => n.index === index) || spent.some((n) => n.index === index)) continue; // a disputed row's other variant already decrypted
    const owned: OwnedNote = { ...note, index, kind: o.epk ? "note" : "deposit" };
    if (spentSet.has(hex32(nullifier(keys.nk, index)))) spent.push(owned);
    else notes.push(owned);
  }
  if (skipped) console.warn(`shield scan: ${skipped} malformed output row(s) skipped`);
  return { notes, spent, confirmed };
}

/** a payment spends notes from one tree (one root per proof): the tree holding the most of the token is tried first */
export function pickInTree(p: Prefetched, tokenId: bigint, amount: bigint): { inputs: OwnedNote[]; tree: Tree; rootSeq: bigint } {
  const byTree = new Map<number, OwnedNote[]>();
  for (const n of p.notes) if (n.token === tokenId) { const id = treeOf(n.index); byTree.set(id, [...(byTree.get(id) ?? []), n]); }
  const sum = (ns: OwnedNote[]) => ns.reduce((s, n) => s + n.v, 0n);
  const order = [...byTree.entries()].sort((a, b) => (sum(b[1]) > sum(a[1]) ? 1 : -1));
  const total = sum([...byTree.values()].flat());
  if (total < amount) throw new Error("Not enough in your shielded balance.");
  for (const [id, notes] of order) {
    const t = p.trees.trees.get(id);
    if (!t) continue;
    try { return { inputs: pick(notes, tokenId, amount), tree: t.tree, rootSeq: t.rootSeq }; } catch { /* try the next tree */ }
  }
  // no single tree pays with two notes, though the balance covers the amount
  if (order.some(([, ns]) => sum(ns) >= amount)) throw new Error("This amount is spread over more than two notes. A payment spends at most two: send yourself the total first, two notes at a time.");
  throw new Error("This amount spans notes in more than one tree, and a payment spends from one. Send yourself what is in each tree, two notes at a time; the change lands in the current tree.");
}
export function pick(notes: OwnedNote[], tokenId: bigint, amount: bigint): OwnedNote[] {
  const same = notes.filter((n) => n.token === tokenId).sort((a, b) => (a.v > b.v ? -1 : 1));
  const chosen: OwnedNote[] = [];
  let sum = 0n;
  for (const n of same) { if (sum >= amount || chosen.length === 2) break; chosen.push(n); sum += n.v; }
  if (sum < amount) {
    const total = same.reduce((s, n) => s + n.v, 0n);
    if (total >= amount) throw new Error("This amount spans more than two of your notes. Send yourself the total first to combine them, then send.");
    throw new Error("Not enough in your shielded balance.");
  }
  return chosen;
}

// snarkjs proof → contract encoding (same as crypto/real.ts)
const g1 = (p: (string | bigint)[]) => w32(BigInt(p[0])) + w32(BigInt(p[1]));
const g2 = (p: (string | bigint)[][]) => w32(BigInt(p[0][1])) + w32(BigInt(p[0][0])) + w32(BigInt(p[1][1])) + w32(BigInt(p[1][0]));

export interface Prepared { action: Record<string, unknown>; outputs: { cm: bigint; v: bigint }[]; nf: bigint[] }

/**
 * Notes and tree read ahead of the click, so that after the click only the proof stands
 * between the user and the wallet window (browsers only allow that window within a few
 * seconds of a click). Valid for a short while; a root a few seconds old is still in the ring.
 */
export interface Prefetched { notes: OwnedNote[]; trees: ChainTrees; at: number }
export async function prefetch(keys: ShieldKeys): Promise<Prefetched> {
  const [{ notes }, trees] = await Promise.all([scan(keys), chainTree()]);
  return { notes, trees, at: Date.now() };
}
const fresh = (p?: Prefetched | null) => (p && Date.now() - p.at < 45000 ? p : null);

/** prove on this device and return the `transfer` action for the sender's wallet to sign */
export async function prove(s: Session, built: ReturnType<typeof buildJoinSplit>, rootSeq: bigint, tokenId: bigint, onProgress?: (f: number, s: string) => void): Promise<Prepared> {
  onProgress?.(0.1, "Building the proof on this device");
  const { proof, publicSignals } = (await snarkjs.groth16.fullProve(built.input, WASM, ZKEY)) as { proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] };
  if (publicSignals.some((x, i) => BigInt(x) !== built.publicSignals[i])) throw new Error("The proof's public values do not match the payment; nothing was sent.");
  const proofHex = g1(proof.pi_a) + g2(proof.pi_b) + g1(proof.pi_c);
  const publics = built.actionPublics.map(w32).join("");
  onProgress?.(0.85, "Waiting for your wallet");
  return {
    action: { account: SHIELD.contract, name: "spend", authorization: [{ actor: s.auth.actor, permission: s.auth.permission }], data: { owner: s.auth.actor, proof: proofHex, publics, amount: built.vPub.toString(), token_id: built.vPub > 0n ? Number(tokenId) : 0, root_seq: rootSeq.toString() } },
    outputs: built.outNotes.map((n) => ({ cm: n.cm, v: n.v })),
    nf: built.nf,
  };
}

/** shielded payment to a registered account; returns the action for the wallet */
export async function prepareSend(s: Session, keys: ShieldKeys, cfg: ShieldConfig, token: Token, to: string, amount: bigint, onProgress?: (f: number, s: string) => void, pre?: Prefetched | null): Promise<Prepared> {
  const entry = cfg.tokens.find((t) => t.token.code === token.code);
  if (!entry) throw new Error(`${token.code} is not enabled in the shielded contract.`);
  onProgress?.(0.02, "Reading your notes");
  const toPk = await registeredKey(to);
  if (!toPk) throw new Error(`${to} has not set up shielded payments yet.`);
  const p = fresh(pre) ?? (await prefetch(keys));
  const { inputs, tree, rootSeq } = pickInTree(p, entry.id, amount);
  const change = inputs.reduce((sum, n) => sum + n.v, 0n) - amount;
  const built = buildJoinSplit({ keys, inputs, outputs: [{ pk: toPk, v: amount }, { pk: keys.pk, v: change }], tree, auditorPk: cfg.auditorPk, sender: nameToU64(s.auth.actor) });
  return prove(s, built, rootSeq, entry.id, onProgress);
}

/** withdrawal to the sender's own account; returns the action for the wallet */
export async function prepareWithdraw(s: Session, keys: ShieldKeys, cfg: ShieldConfig, token: Token, amount: bigint, onProgress?: (f: number, s: string) => void, pre?: Prefetched | null): Promise<Prepared> {
  const entry = cfg.tokens.find((t) => t.token.code === token.code);
  if (!entry) throw new Error(`${token.code} is not enabled in the shielded contract.`);
  onProgress?.(0.02, "Reading your notes");
  const p = fresh(pre) ?? (await prefetch(keys));
  const { inputs, tree, rootSeq } = pickInTree(p, entry.id, amount);
  const change = inputs.reduce((sum, n) => sum + n.v, 0n) - amount;
  const me = nameToU64(s.auth.actor);
  const built = buildJoinSplit({ keys, inputs, outputs: [{ pk: keys.pk, v: 0n }, { pk: keys.pk, v: change }], tree, auditorPk: cfg.auditorPk, sender: me, vPub: amount, tokenPub: entry.id, to: me });
  return prove(s, built, rootSeq, entry.id, onProgress);
}

// ---- wallet-signed actions ----

export interface BackupRow { phrase: string; committee: string }
/** the account's recovery copies on chain, or null when none (the whole table is read: no request names the account) */
export async function backupRow(actor: string): Promise<BackupRow | null> {
  const row = await agreedRow<{ owner: string; phrase: string; committee: string }>("backups", "owner", actor, (r) => `${r.phrase}|${r.committee}`.toLowerCase());
  return row ? { phrase: row.phrase, committee: row.committee } : null;
}
/** one account's row of a table as two nodes agree on it (whole-table reads, matched locally); null when agreed absent */
async function agreedRow<T extends Record<string, unknown>>(table: string, key: string, owner: string, ident: (r: T) => string): Promise<T | null> {
  const answers = await Promise.allSettled([...new Set(ENDPOINTS)].map(async (ep) => (await rows<T>(table, key, ep)).find((r) => r.owner === owner) ?? null));
  const got = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  if (got.length < 2) throw new Error(`Cannot confirm the ${table} row with two independent servers. Try again shortly.`);
  const k = (r: T | null) => (r ? ident(r) : "");
  const agreed = got.find((r) => got.filter((o) => k(o) === k(r)).length >= 2);
  if (agreed === undefined) throw new Error(`The servers disagree about the ${table} row. Try again shortly.`);
  return agreed;
}
/** store, replace or clear the owner's recovery copies; hex without 0x, empty to clear */
export function setBackupAction(s: Session, phrase: string, committee: string) {
  return { account: SHIELD.contract, name: "setbackup", authorization: [{ actor: s.auth.actor, permission: s.auth.permission }], data: { owner: s.auth.actor, phrase, committee } };
}

export function registerAction(s: Session, pk: Pt) {
  return { account: SHIELD.contract, name: "register", authorization: [{ actor: s.auth.actor, permission: s.auth.permission }], data: { owner: s.auth.actor, pubkey: ptHex(pk) } };
}

/**
 * A deposit is two actions in one wallet transaction: the token transfer whose memo carries the
 * note's random value, and the owner's `deposit`, which places the note and pays for its rows.
 */
export function depositActions(s: Session, cfg: ShieldConfig, token: Token, pk: Pt, amount: bigint, hasSlot = true) {
  const entry = cfg.tokens.find((t) => t.token.code === token.code);
  if (!entry) throw new Error(`${token.code} is not enabled in the shielded contract.`);
  const note = newNote(pk, amount, entry.id);
  const quantity = `${(Number(amount) / 10 ** token.precision).toFixed(token.precision)} ${token.code}`;
  const auth = [{ actor: s.auth.actor, permission: s.auth.permission }];
  return {
    note,
    actions: [
      ...(hasSlot ? [] : [openSlotAction(s)]),
      { account: entry.contract, name: "transfer", authorization: auth, data: { from: s.auth.actor, to: SHIELD.contract, quantity, memo: `shield:${hex32(note.r)}` } },
      { account: SHIELD.contract, name: "deposit", authorization: auth, data: { owner: s.auth.actor, r: hex32(note.r) } },
    ],
  };
}

/** deposits that arrived but were never placed (the second action did not run) */
export async function unfinishedDeposits(actor: string): Promise<{ id: number; amount: bigint; sym: string; r: string }[]> {
  const slot = await depositSlot(actor);
  return slot && slot.amount > 0n ? [{ id: 0, amount: slot.amount, sym: slot.sym, r: slot.r }] : [];
}
/** the account's owner-paid deposit slot: null when the account has none yet (registered before slots existed) */
export async function depositSlot(actor: string): Promise<{ amount: bigint; sym: string; r: string } | null> {
  const row = await agreedRow<{ owner: string; sym: string | number; amount: string | number; r: string }>("credits", "owner", actor, (c) => `${c.sym}|${c.amount}|${c.r}`.toLowerCase());
  return row ? { amount: BigInt(row.amount), sym: String(row.sym), r: row.r } : null;
}
/** creates the slot for an account registered before slots existed; idempotent */
export function openSlotAction(s: Session) {
  return { account: SHIELD.contract, name: "open", authorization: [{ actor: s.auth.actor, permission: s.auth.permission }], data: { owner: s.auth.actor } };
}
export function finishDepositAction(s: Session, r: string) {
  return { account: SHIELD.contract, name: "deposit", authorization: [{ actor: s.auth.actor, permission: s.auth.permission }], data: { owner: s.auth.actor, r } };
}

export const txLink = (txid: string) => `${EXPLORER}/transaction/${txid}`;

// ---- the auditor's view ----

export interface ShieldLedgerRow {
  index: number;
  kind: NoteKind;
  to: string; // account name, or a key fingerprint if unregistered
  from: string; // the signed action's owner, "deposit", or "unknown" without history
  amount: bigint;
  token: bigint;
  spent: boolean;
  valid: boolean;
}

/** one signed spend from history: who, when, the nullifiers and commitments it carried, the public amount */
export interface SpendRecord { owner: string; ts: string; trx: string; block: number; publics: string; nf: string[]; cm: string[]; amount: bigint; tokenId: bigint }
/** every spend on the contract, oldest first, from the first history node that answers; [] when none does */
export async function spendHistory(): Promise<SpendRecord[] | null> {
  for (const h of HYPERIONS) {
    try {
      const out: SpendRecord[] = [];
      let skip = 0;
      for (let page = 0; page < 50; page++) {
        const r = await fetch(`${h}/v2/history/get_actions?account=${SHIELD.contract}&filter=${SHIELD.contract}:spend&limit=100&skip=${skip}&sort=asc`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { actions: { timestamp: string; trx_id: string; block_num: number; act: { data: { owner?: string; publics?: string; amount?: string | number; token_id?: string | number } } }[] };
        for (const a of j.actions) {
          const p = (a.act.data.publics ?? "").toLowerCase();
          if (!a.act.data.owner || p.length < 4 * 64 || !/^[0-9a-f]{64}$/.test(a.trx_id)) continue;
          out.push({ owner: a.act.data.owner, ts: a.timestamp, trx: a.trx_id.toLowerCase(), block: Number(a.block_num), publics: p, nf: [p.slice(0, 64), p.slice(64, 128)], cm: [p.slice(128, 192), p.slice(192, 256)], amount: BigInt(a.act.data.amount ?? 0), tokenId: BigInt(a.act.data.token_id ?? 0) });
        }
        if (j.actions.length < 100) break;
        skip += 100;
      }
      return out;
    } catch { /* next history node */ }
  }
  return null;
}
/**
 * A history record is only believed once a chain node's block confirms it: the transaction is in
 * that block, the action is this contract's `spend`, its data (owner, publics, amount, token) is
 * what history claims, and the owner authorised it. Verified records are remembered per
 * transaction id in this browser, so each block is fetched once.
 */
const VERIFIED = "pulse-privacy/shield/verified";
/** the record as the chain's block has it, or null when the block does not confirm it; history only says where to look */
export async function verifySpend(rec: SpendRecord): Promise<SpendRecord | null> {
  let cache: Record<string, string> = {};
  try { cache = JSON.parse(localStorage.getItem(VERIFIED) ?? "{}") as Record<string, string>; } catch { /* ignore */ }
  const fromFp = (fp: string): SpendRecord | null => {
    const [owner, publics, amount, tokenId, block, ts] = fp.split("|");
    if (!owner || !publics) return null;
    return { ...rec, owner, publics, block: Number(block), ts, nf: [publics.slice(0, 64), publics.slice(64, 128)], cm: [publics.slice(128, 192), publics.slice(192, 256)], amount: BigInt(amount), tokenId: BigInt(tokenId) };
  };
  const ckey = `${rec.trx}|${rec.publics.slice(0, 64)}`; // transaction plus first nullifier: one entry per spend action
  if (cache[ckey]) return fromFp(cache[ckey]);
  try {
    const b = await rpc<{ timestamp: string; transactions: { trx: { id?: string; transaction?: { actions: { account: string; name: string; authorization: { actor: string }[]; data: Record<string, unknown> }[] } } | string }[] }>("get_block", { block_num_or_id: rec.block });
    const t = b.transactions.find((x) => typeof x.trx === "object" && x.trx.id?.toLowerCase() === rec.trx);
    if (!t || typeof t.trx !== "object" || !t.trx.transaction) return null;
    const a = t.trx.transaction.actions.find((x) => x.account === SHIELD.contract && x.name === "spend" && typeof x.data === "object" && x.data !== null && String(x.data.publics ?? "").toLowerCase() === rec.publics);
    if (!a) return null;
    const owner = String(a.data.owner ?? "");
    if (!owner || !a.authorization.some((z) => z.actor === owner)) return null;
    const fp = [owner, rec.publics, String(a.data.amount ?? 0), String(a.data.token_id ?? 0), String(rec.block), b.timestamp].join("|");
    cache[ckey] = fp;
    try { localStorage.setItem(VERIFIED, JSON.stringify(cache)); } catch { /* ignore */ }
    return fromFp(fp);
  } catch { return null; }
}
/**
 * Records that are verified, unique by transaction and by first nullifier, whose nullifier is
 * spent on chain and whose outputs are leaves on chain (a spend from before a testnet reset can
 * share a nullifier with a current one; only the one whose outputs exist counts).
 */
async function verifiedSpends(nfOnChain: Set<string>, cmOnChain: Set<string>, relevant: (r: SpendRecord) => boolean): Promise<SpendRecord[] | null> {
  const all = await spendHistory();
  if (all === null) return null;
  const seenNf = new Set<string>(); // a spend is identified by its first nullifier, which the chain allows once
  const out: SpendRecord[] = [];
  for (const r of all) {
    if (seenNf.has(r.nf[0]) || !nfOnChain.has(r.nf[0]) || !r.cm.every((c) => cmOnChain.has(c))) continue;
    if (!relevant(r)) continue;
    const v = await verifySpend(r);
    if (!v) continue;
    seenNf.add(v.nf[0]);
    out.push(v);
  }
  return out;
}
/** map commitment → the account that signed the spend creating it (verified against the chain) */
async function sendersByCommitment(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const [nfs, lv] = await Promise.all([rows<{ key: string | number; nf: string }>("nullifiers", "key"), rows<{ index: string | number; cm: string }>("outputs", "index")]);
  for (const sp of (await verifiedSpends(new Set(nfs.map((n) => n.nf.toLowerCase())), new Set(lv.map((l) => l.cm.toLowerCase())), () => true)) ?? []) for (const cm of sp.cm) out.set(cm, sp.owner);
  return out;
}

/** every deposit placement on the contract from history, keyed by owner and note random value → when (no request names the account; the match is local) */
async function depositHistory(): Promise<Map<string, { ts: string; trx: string }>> {
  const out = new Map<string, { ts: string; trx: string }>();
  for (const h of HYPERIONS) {
    try {
      let skip = 0;
      for (let page = 0; page < 50; page++) {
        const r = await fetch(`${h}/v2/history/get_actions?account=${SHIELD.contract}&filter=${SHIELD.contract}:deposit&limit=100&skip=${skip}&sort=asc`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { actions: { timestamp: string; trx_id: string; act: { data: { owner?: string; r?: string } } }[] };
        for (const a of j.actions) if (a.act.data.r && a.act.data.owner) out.set(`${a.act.data.owner}|${a.act.data.r.toLowerCase()}`, { ts: a.timestamp, trx: a.trx_id });
        if (j.actions.length < 100) break;
        skip += 100;
      }
      return out;
    } catch { /* next */ }
  }
  return out;
}

/** what the sender's browser remembered about its own payments: the chain does not hold the receiver */
const SENDS = (actor: string) => `pulse-privacy/shield/${actor}/sends`;
export function rememberSend(actor: string, trx: string, to: string) {
  try {
    const cur = JSON.parse(localStorage.getItem(SENDS(actor)) ?? "{}") as Record<string, string>;
    cur[trx] = to;
    localStorage.setItem(SENDS(actor), JSON.stringify(cur));
  } catch { /* ignore */ }
}
const rememberedSends = (actor: string): Record<string, string> => { try { return JSON.parse(localStorage.getItem(SENDS(actor)) ?? "{}") as Record<string, string>; } catch { return {}; } };

export interface ActivityEvent {
  kind: "deposit" | "received" | "sent" | "withdrew";
  ts: string | null; // history time, ISO without zone (UTC); null when history is unavailable
  trx: string | null;
  amount: bigint;
  token: bigint;
  counterparty: string | null; // who paid (received), whom (sent, if this browser remembers), the account (withdrew)
  notes: number[]; // the notes involved: created (deposit, received) or spent (sent, withdrew)
  change?: bigint;
  changeNote?: number;
}

/**
 * The account's activity as events rather than notes: deposits, payments received (the payer
 * is the account that signed the spend), payments sent (amount from the note arithmetic, the
 * receiver from this browser's memory), withdrawals. Falls back to notes alone when no history
 * node answers.
 */
export async function activity(keys: ShieldKeys, actor: string, res: ScanResult): Promise<{ events: ActivityEvent[]; history: boolean }> {
  const mine = [...res.notes, ...res.spent];
  const byCm = new Map(mine.map((n) => [hex32(n.cm), n]));
  const byNf = new Map(mine.map((n) => [hex32(nullifier(keys.nk, n.index)), n]));
  const [deposits, leafRows, nfRows] = await Promise.all([depositHistory(), rows<{ index: string | number; cm: string }>("outputs", "index"), rows<{ key: string | number; nf: string }>("nullifiers", "key")]);
  const onChain = new Set(leafRows.map((l) => l.cm.toLowerCase()));
  // only spends that touch this account's notes are fetched from a chain node and verified
  const spends = await verifiedSpends(new Set(nfRows.map((n) => n.nf.toLowerCase())), onChain, (r) => r.cm.some((c) => byCm.has(c)) || r.nf.some((f) => byNf.has(f)));
  const sends = rememberedSends(actor);
  const events: ActivityEvent[] = [];
  for (const n of mine) {
    if (n.kind !== "deposit") continue;
    const d = deposits.get(`${actor}|${hex32(n.r)}`);
    events.push({ kind: "deposit", ts: d?.ts ?? null, trx: d?.trx ?? null, amount: n.v, token: n.token, counterparty: actor, notes: [n.index] });
  }
  const seen = new Set<number>();
  for (const sp of spends ?? []) {
    // a spend whose outputs are not leaves on the current chain is stale history (a testnet reset)
    if (!sp.cm.every((c) => onChain.has(c))) continue;
    const created = sp.cm.map((c) => byCm.get(c)).filter((n): n is OwnedNote => !!n);
    const spent = sp.nf.map((f) => byNf.get(f)).filter((n): n is OwnedNote => !!n);
    if (sp.owner !== actor) {
      for (const n of created) { events.push({ kind: "received", ts: sp.ts, trx: sp.trx, amount: n.v, token: n.token, counterparty: sp.owner, notes: [n.index] }); seen.add(n.index); }
      continue;
    }
    if (!spent.length && !created.length) continue;
    const sumIn = spent.reduce((a, n) => a + n.v, 0n);
    const change = created.reduce((a, n) => a + n.v, 0n);
    const token = spent[0]?.token ?? created[0]?.token ?? 0n;
    created.forEach((n) => seen.add(n.index));
    const changeNote = created.find((n) => n.v > 0n)?.index;
    if (sp.amount > 0n) events.push({ kind: "withdrew", ts: sp.ts, trx: sp.trx, amount: sp.amount, token: sp.tokenId || token, counterparty: actor, notes: spent.map((n) => n.index), change, changeNote });
    const sent = sumIn - change - sp.amount;
    if (sent > 0n) events.push({ kind: "sent", ts: sp.ts, trx: sp.trx, amount: sent, token, counterparty: sends[sp.trx] ?? null, notes: spent.map((n) => n.index), change, changeNote });
  }
  // sealed notes with no matching spend in history (history behind, or none): show as received from an unknown payer
  for (const n of mine) if (n.kind !== "deposit" && !seen.has(n.index)) events.push({ kind: "received", ts: null, trx: null, amount: n.v, token: n.token, counterparty: null, notes: [n.index] });
  events.sort((a, b) => (b.ts ?? "9").localeCompare(a.ts ?? "9") || Math.max(...b.notes) - Math.max(...a.notes));
  return { events, history: spends !== null };
}

/** every note in the ledger, opened with the auditor's spending scalar (hex or decimal) */
export async function auditorLedger(auditorSecret: string): Promise<ShieldLedgerRow[]> {
  const ask = BigInt(auditorSecret.trim().startsWith("0x") ? auditorSecret.trim() : /^[0-9]+$/.test(auditorSecret.trim()) ? auditorSecret.trim() : "0x" + auditorSecret.trim());
  const [outs, leaves, nfs, keys, senders] = await Promise.all([
    rows<{ index: string | number; epk: string; cr: string; ca: string }>("outputs", "index"),
    rows<{ index: string | number; cm: string }>("outputs", "index"),
    rows<{ key: string | number; nf: string }>("nullifiers", "key"),
    registeredKeys(),
    sendersByCommitment(),
  ]);
  const cmOf = new Map(leaves.map((l) => [Number(l.index), BigInt("0x" + l.cm)]));
  const byKey = new Map<string, string>();
  for (const [name, pk] of keys) byKey.set(hex32(pk[0]) + hex32(pk[1]), name);
  const nfSet = new Set(nfs.map((n) => n.nf));
  const result: ShieldLedgerRow[] = [];
  for (const o of outs) {
    const index = Number(o.index);
    const cm = cmOf.get(index);
    if (cm === undefined) continue;
    try {
      if (!o.epk) {
        const [packed, r] = words(o.cr);
        const [v, token] = unpack(packed);
        // a deposit is public: find the registered key whose note this is
        let to = "unknown";
        for (const [name, pk] of keys) { if (commitment({ pk, v, token, r }) === cm) { to = name; break; } }
        result.push({ index, kind: "deposit", to, from: "deposit", amount: v, token, spent: false, valid: to !== "unknown" });
      } else {
        const epk = decompressPoint(words(o.epk)[0]);
        const n = decryptAuditor(ask, epk, words(o.ca), cm);
        if (!n) { result.push({ index, kind: "note", to: "unreadable", from: senders.get(hex32(cm)) ?? "unknown", amount: 0n, token: 0n, spent: false, valid: false }); continue; }
        const to = byKey.get(hex32(n.pk[0]) + hex32(n.pk[1])) ?? `unregistered ${keyFingerprint(n.pk)}`;
        result.push({ index, kind: "note", to, from: senders.get(hex32(cm)) ?? "unknown", amount: n.v, token: n.token, spent: false, valid: n.valid });
      }
    } catch { result.push({ index, kind: "note", to: "malformed", from: "unknown", amount: 0n, token: 0n, spent: false, valid: false }); }
  }
  // spent status needs each owner's nullifier key, which the auditor does not hold; nullifier count is shown instead
  void nfSet;
  return result;
}

export interface ShieldEdges { escrow: Record<string, bigint>; deposits: Record<string, bigint>; withdrawals: Record<string, bigint>; unfinished: Record<string, bigint>; nullifiers: number; leaves: number; slotsUsed: number; capacity: number; trees: number; activeTree: number }

/** escrow against the contract's own counters, per token */
export async function shieldEdges(cfg: ShieldConfig): Promise<ShieldEdges> {
  const escrow: Record<string, bigint> = {}, deposits: Record<string, bigint> = {}, withdrawals: Record<string, bigint> = {}, unfinished: Record<string, bigint> = {};
  const t = await rows<{ sym: string | number; token_id: string | number; deposits: string | number; withdrawals: string | number }>("tokens", "sym");
  for (const row of t) {
    const entry = cfg.tokens.find((e) => e.id === BigInt(row.token_id));
    if (!entry) continue;
    deposits[entry.token.code] = BigInt(row.deposits);
    withdrawals[entry.token.code] = BigInt(row.withdrawals);
    const bal = await rpc<string[]>("get_currency_balance", { code: entry.contract, account: SHIELD.contract, symbol: entry.token.code }).catch(() => [] as string[]);
    escrow[entry.token.code] = bal.length ? BigInt(Math.round(parseFloat(bal[0]) * 10 ** entry.token.precision)) : 0n;
  }
  const credits = await rows<{ sym: string | number; amount: string | number }>("credits", "owner");
  for (const c of credits) {
    if (BigInt(c.amount) === 0n) continue; const entry = cfg.tokens.find((e) => e.token.raw === String(c.sym)); const code = entry?.token.code ?? String(c.sym); unfinished[code] = (unfinished[code] ?? 0n) + BigInt(c.amount); }
  const [nfs, lv] = await Promise.all([rows<{ key: string | number }>("nullifiers", "key"), rows<{ index: string | number }>("outputs", "index")]);
  // capacity is measured in tree slots (the agreed next_leaf): a deposit stores one output row but takes two slots
  const agreed = await agreedTrees();
  const active = agreed.trees.find((t) => t.id === agreed.active) ?? agreed.trees[agreed.trees.length - 1];
  return { escrow, deposits, withdrawals, unfinished, nullifiers: nfs.length, leaves: lv.length, slotsUsed: active?.next ?? 0, capacity: 1 << 20, trees: agreed.trees.length, activeTree: agreed.active };
}
