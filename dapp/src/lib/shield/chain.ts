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

const WASM = "/circuit/joinsplit-r3.wasm";
const ZKEY = "/circuit/joinsplit-r3_final.zkey";

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

async function rows<T extends Record<string, unknown>>(table: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let lower: string | undefined;
  for (;;) {
    const r = await rpc<{ rows: T[]; more: boolean }>("get_table_rows", { code: SHIELD.contract, scope: SHIELD.contract, table, json: true, limit: 1000, lower_bound: lower });
    out.push(...r.rows);
    if (!r.more || r.rows.length === 0) return out;
    const last = r.rows[r.rows.length - 1][key];
    if (typeof last === "string" && !/^\d+$/.test(last)) { lower = last; if (out.length > 5000) return out; } // name keys: the API resumes after the bound
    else lower = (BigInt(String(last)) + 1n).toString();
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

/** every account with a shielded key, for the recipient suggestions (cached briefly) */
let namesCache: { at: number; names: string[] } | null = null;
export async function registeredNames(): Promise<string[]> {
  if (namesCache && Date.now() - namesCache.at < 60000) return namesCache.names;
  const r = await rows<{ owner: string }>("keys", "owner").catch(() => [] as { owner: string }[]);
  namesCache = { at: Date.now(), names: r.map((k) => k.owner).sort() };
  return namesCache.names;
}

export async function registeredKey(actor: string): Promise<Pt | null> {
  const r = await rpc<{ rows: { owner: string; pubkey: string }[] }>("get_table_rows", { code: SHIELD.contract, scope: SHIELD.contract, table: "keys", lower_bound: actor, upper_bound: actor, limit: 1, json: true });
  if (!r.rows.length) return null;
  const w = words(r.rows[0].pubkey);
  return [w[0], w[1]];
}

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
  for (const o of outs) {
    const index = Number(o.index);
    const cm = cmOf.get(index);
    if (cm === undefined) continue;
    let note = null;
    if (!o.epk) {
      const [packed, r] = words(o.cr);
      const [v, token] = unpack(packed);
      const cand = { pk: keys.pk, v, token, r, cm: 0n };
      cand.cm = commitment(cand);
      if (cand.cm === cm) note = cand;
    } else {
      note = tryDecryptReceiver(keys, decompressPoint(words(o.epk)[0]), words(o.cr), cm);
    }
    if (!note || note.v === 0n) continue;
    const owned = { ...note, index };
    if (spentSet.has(hex32(nullifier(keys.nk, index)))) spent.push(owned);
    else notes.push(owned);
  }
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
    action: { account: SHIELD.contract, name: "spend", authorization: [{ actor: s.auth.actor, permission: s.auth.permission }], data: { owner: s.auth.actor, proof: proofHex, publics, amount: built.vPub.toString(), token_id: Number(tokenId), root_seq: rootSeq.toString() } },
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
