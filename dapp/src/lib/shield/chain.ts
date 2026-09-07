// The shielded contract (xprshield) from the browser: table reads, note scanning, the tree,
// proving, and the actions the wallet signs. Every chain write is a wallet transaction of the
// sender; the proof hides the receiver, the amount and the notes spent (docs/06 §8).
import * as snarkjs from "snarkjs";
import { ENDPOINTS, EXPLORER, SHIELD } from "../../config";
import type { Session } from "../chain";
import type { Pt } from "../crypto/babyjub";
import { ptHex, w32 } from "../crypto/babyjub";
import type { Token } from "../token";
import { Tree, buildJoinSplit, commitment, decompressPoint, hex32, nameToU64, newNote, nullifier, tryDecryptReceiver, unpack, words } from "./notes";
import type { OwnedNote, ShieldKeys } from "./notes";

const WASM = "/circuit/joinsplit-r4.wasm";
const ZKEY = "/circuit/joinsplit-r4_final.zkey";

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

export async function getConfig(knownTokens: Token[]): Promise<ShieldConfig | null> {
  const c = await rpc<{ rows: { auditor_pubkey: string; paused: number | boolean }[] }>("get_table_rows", { code: SHIELD.contract, scope: SHIELD.contract, table: "config", json: true, limit: 1 });
  if (!c.rows.length) return null;
  const a = words(c.rows[0].auditor_pubkey);
  const t = await rows<{ sym: string | number; token_contract: string; token_id: string | number; max_pool: string | number; max_deposit: string | number; pool: string | number }>("tokens", "sym");
  const tokens = t.flatMap((row) => {
    const raw = BigInt(row.sym);
    const precision = Number(raw & 0xffn);
    let code = "";
    for (let i = 1; i < 8; i++) { const ch = Number((raw >> BigInt(8 * i)) & 0xffn); if (ch) code += String.fromCharCode(ch); }
    const token = knownTokens.find((k) => k.code === code) ?? ({ code, precision, contract: row.token_contract } as Token);
    return [{ token, id: BigInt(row.token_id), contract: row.token_contract, maxPool: BigInt(row.max_pool), maxDeposit: BigInt(row.max_deposit), pool: BigInt(row.pool) }];
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

/** the tree rebuilt from the leaves table; throws if it disagrees with the contract's root */
export async function chainTree(): Promise<{ tree: Tree; nextLeaf: number; rootSeq: bigint }> {
  const t = await rpc<{ rows: { next_leaf: string | number; root: string; root_seq: string | number }[] }>("get_table_rows", { code: SHIELD.contract, scope: SHIELD.contract, table: "tree", json: true, limit: 1 });
  const next = Number(t.rows[0]?.next_leaf ?? 0);
  const leaves = await rows<{ index: string | number; cm: string }>("leaves", "index");
  const byIndex = new Map(leaves.map((l) => [Number(l.index), BigInt("0x" + l.cm)]));
  const tree = new Tree();
  for (let i = 0; i < next; i++) tree.append(byIndex.get(i) ?? 0n);
  if (t.rows.length && hex32(tree.root) !== t.rows[0].root) throw new Error("The tree read from the chain does not match the contract's root; try again.");
  return { tree, nextLeaf: next, rootSeq: BigInt(t.rows[0]?.root_seq ?? 0) };
}

export interface ScanResult { notes: OwnedNote[]; spent: OwnedNote[]; }

/** every note of ours, from the outputs, leaves and nullifiers tables; zero-value notes are skipped */
export async function scan(keys: ShieldKeys): Promise<ScanResult> {
  const [outs, leaves, nfs] = await Promise.all([
    rows<{ index: string | number; epk: string; cr: string; ca: string }>("outputs", "index"),
    rows<{ index: string | number; cm: string }>("leaves", "index"),
    rows<{ key: string | number; nf: string }>("nullifiers", "key"),
  ]);
  const cmOf = new Map(leaves.map((l) => [Number(l.index), BigInt("0x" + l.cm)]));
  const spentSet = new Set(nfs.map((n) => n.nf));
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
    const owned = { ...note, index };
    if (spentSet.has(hex32(nullifier(keys.nk, index)))) spent.push(owned);
    else notes.push(owned);
  }
  if (skipped) console.warn(`shield scan: ${skipped} malformed output row(s) skipped`);
  return { notes, spent };
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
export interface Prefetched { notes: OwnedNote[]; tree: Tree; rootSeq: bigint; at: number }
export async function prefetch(keys: ShieldKeys): Promise<Prefetched> {
  const [{ notes }, { tree, rootSeq }] = await Promise.all([scan(keys), chainTree()]);
  return { notes, tree, rootSeq, at: Date.now() };
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
  const inputs = pick(p.notes, entry.id, amount);
  const { tree, rootSeq } = p;
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
  const inputs = pick(p.notes, entry.id, amount);
  const { tree, rootSeq } = p;
  const change = inputs.reduce((sum, n) => sum + n.v, 0n) - amount;
  const me = nameToU64(s.auth.actor);
  const built = buildJoinSplit({ keys, inputs, outputs: [{ pk: keys.pk, v: 0n }, { pk: keys.pk, v: change }], tree, auditorPk: cfg.auditorPk, sender: me, vPub: amount, tokenPub: entry.id, to: me });
  return prove(s, built, rootSeq, entry.id, onProgress);
}

// ---- wallet-signed actions ----

export function registerAction(s: Session, pk: Pt) {
  return { account: SHIELD.contract, name: "register", authorization: [{ actor: s.auth.actor, permission: s.auth.permission }], data: { owner: s.auth.actor, pubkey: ptHex(pk) } };
}

/** a deposit is a token transfer whose memo carries the note's random values */
export function depositAction(s: Session, cfg: ShieldConfig, token: Token, pk: Pt, amount: bigint) {
  const entry = cfg.tokens.find((t) => t.token.code === token.code);
  if (!entry) throw new Error(`${token.code} is not enabled in the shielded contract.`);
  const note = newNote(pk, amount, entry.id);
  const quantity = `${(Number(amount) / 10 ** token.precision).toFixed(token.precision)} ${token.code}`;
  return {
    note,
    action: { account: entry.contract, name: "transfer", authorization: [{ actor: s.auth.actor, permission: s.auth.permission }], data: { from: s.auth.actor, to: SHIELD.contract, quantity, memo: `shield:${hex32(note.r)}` } },
  };
}

export const txLink = (txid: string) => `${EXPLORER}/transaction/${txid}`;
