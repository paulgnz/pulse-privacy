// The shielded contract (xprshield) from the browser: table reads, note scanning, the tree,
// proving, and the actions the wallet signs. Every chain write is a wallet transaction of the
// sender; the proof hides the receiver, the amount and the notes spent (docs/06 §8).
import * as snarkjs from "snarkjs";
import { ENDPOINTS, EXPLORER, SHIELD } from "../../config";
import type { Session } from "../chain";
import type { Pt } from "../crypto/babyjub";
import { ptHex, w32 } from "../crypto/babyjub";
import type { Token } from "../token";
import { Tree, buildJoinSplit, commitment, hex32, nameToU64, newNote, nullifier, tryDecryptReceiver, words } from "./notes";
import type { OwnedNote, ShieldKeys } from "./notes";

const WASM = "/circuit/joinsplit.wasm";
const ZKEY = "/circuit/joinsplit_final.zkey";

async function rpc<T>(path: string, body: unknown): Promise<T> {
  let lastErr: unknown;
  for (const ep of ENDPOINTS) {
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
    lower = (BigInt(String(r.rows[r.rows.length - 1][key])) + 1n).toString();
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

export async function registeredKey(actor: string): Promise<Pt | null> {
  const r = await rpc<{ rows: { owner: string; pubkey: string }[] }>("get_table_rows", { code: SHIELD.contract, scope: SHIELD.contract, table: "keys", lower_bound: actor, upper_bound: actor, limit: 1, json: true });
  if (!r.rows.length) return null;
  const w = words(r.rows[0].pubkey);
  return [w[0], w[1]];
}

/** the tree rebuilt from the leaves table; throws if it disagrees with the contract's root */
export async function chainTree(): Promise<{ tree: Tree; nextLeaf: number }> {
  const t = await rpc<{ rows: { next_leaf: string | number; root: string }[] }>("get_table_rows", { code: SHIELD.contract, scope: SHIELD.contract, table: "tree", json: true, limit: 1 });
  const next = Number(t.rows[0]?.next_leaf ?? 0);
  const leaves = await rows<{ index: string | number; cm: string }>("leaves", "index");
  const byIndex = new Map(leaves.map((l) => [Number(l.index), BigInt("0x" + l.cm)]));
  const tree = new Tree();
  for (let i = 0; i < next; i++) tree.append(byIndex.get(i) ?? 0n);
  if (t.rows.length && hex32(tree.root) !== t.rows[0].root) throw new Error("The tree read from the chain does not match the contract's root; try again.");
  return { tree, nextLeaf: next };
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
      const [v, token, rho, r] = words(o.cr);
      const cand = { pk: keys.pk, v, token, rho, r, cm: 0n };
      cand.cm = commitment(cand);
      if (cand.cm === cm) note = cand;
    } else {
      const e = words(o.epk);
      note = tryDecryptReceiver(keys, [e[0], e[1]], words(o.cr), cm);
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

/** prove on this device and return the `transfer` action for the sender's wallet to sign */
export async function prove(s: Session, built: ReturnType<typeof buildJoinSplit>, onProgress?: (f: number, s: string) => void): Promise<Prepared> {
  onProgress?.(0.1, "Building the proof on this device");
  const { proof, publicSignals } = (await snarkjs.groth16.fullProve(built.input, WASM, ZKEY)) as { proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] };
  if (publicSignals.some((x, i) => BigInt(x) !== built.publicSignals[i])) throw new Error("The proof's public values do not match the payment; nothing was sent.");
  const proofHex = g1(proof.pi_a) + g2(proof.pi_b) + g1(proof.pi_c);
  const publics = built.actionPublics.map(w32).join("");
  onProgress?.(0.85, "Waiting for your wallet");
  return {
    action: { account: SHIELD.contract, name: "spend", authorization: [{ actor: s.auth.actor, permission: s.auth.permission }], data: { sender: s.auth.actor, proof: proofHex, publics } },
    outputs: built.outNotes.map((n) => ({ cm: n.cm, v: n.v })),
    nf: built.nf,
  };
}

/** shielded payment to a registered account; returns the action for the wallet */
export async function prepareSend(s: Session, keys: ShieldKeys, cfg: ShieldConfig, token: Token, to: string, amount: bigint, onProgress?: (f: number, s: string) => void): Promise<Prepared> {
  const entry = cfg.tokens.find((t) => t.token.code === token.code);
  if (!entry) throw new Error(`${token.code} is not enabled in the shielded contract.`);
  onProgress?.(0.02, "Reading your notes");
  const toPk = await registeredKey(to);
  if (!toPk) throw new Error(`${to} has not set up shielded payments yet.`);
  const { notes } = await scan(keys);
  const inputs = pick(notes, entry.id, amount);
  const { tree } = await chainTree();
  const change = inputs.reduce((sum, n) => sum + n.v, 0n) - amount;
  const built = buildJoinSplit({ keys, inputs, outputs: [{ pk: toPk, v: amount }, { pk: keys.pk, v: change }], tree, auditorPk: cfg.auditorPk, sender: nameToU64(s.auth.actor) });
  return prove(s, built, onProgress);
}

/** withdrawal to the sender's own account; returns the action for the wallet */
export async function prepareWithdraw(s: Session, keys: ShieldKeys, cfg: ShieldConfig, token: Token, amount: bigint, onProgress?: (f: number, s: string) => void): Promise<Prepared> {
  const entry = cfg.tokens.find((t) => t.token.code === token.code);
  if (!entry) throw new Error(`${token.code} is not enabled in the shielded contract.`);
  onProgress?.(0.02, "Reading your notes");
  const { notes } = await scan(keys);
  const inputs = pick(notes, entry.id, amount);
  const { tree } = await chainTree();
  const change = inputs.reduce((sum, n) => sum + n.v, 0n) - amount;
  const me = nameToU64(s.auth.actor);
  const built = buildJoinSplit({ keys, inputs, outputs: [{ pk: keys.pk, v: 0n }, { pk: keys.pk, v: change }], tree, auditorPk: cfg.auditorPk, sender: me, vPub: amount, tokenPub: entry.id, to: me });
  return prove(s, built, onProgress);
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
    action: { account: entry.contract, name: "transfer", authorization: [{ actor: s.auth.actor, permission: s.auth.permission }], data: { from: s.auth.actor, to: SHIELD.contract, quantity, memo: `shield:${hex32(note.rho)}:${hex32(note.r)}` } },
  };
}

export const txLink = (txid: string) => `${EXPLORER}/transaction/${txid}`;
