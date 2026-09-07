// Chain access. Reads go to the testnet RPC and Hyperion; writes go through the WebAuth
// session (`session.transact`). Action shapes match the deployed `xprconf` ABI
// (contracts/xpr-conf-tsc, 2026-09-07):
//   register(owner, sym, enc_pubkey) · applypending(owner, sym) · send(from, sym, to, t, b_new, proof)
//   withdraw(owner, quantity, b_new, proof) · deposit = eosio.token::transfer memo conf:<owner>
// Byte layouts (bare hex on chain, 0x-prefixed in the app):
//   point = x‖y (64 B) · pair set = lo.C lo.D hi.C hi.D (256 B) · t = per chunk C Ds Dr Da (512 B)
import type { ConnectWalletArgs, ConnectWalletRet } from "@proton/web-sdk";

// The XPR SDK must be loaded with dynamic imports alongside @proton/link (static imports leave
// the mobile transport unregistered and the app-signing flow spins forever after signing).
type Sdk = (args: ConnectWalletArgs) => Promise<ConnectWalletRet>;
let sdkReady: Promise<Sdk> | null = null;
function loadSdk(): Promise<Sdk> {
  if (!sdkReady) {
    sdkReady = Promise.all([import("@proton/web-sdk"), import("@proton/link")]).then(([mod]) => mod.default as unknown as Sdk);
  }
  return sdkReady;
}
import { APP_NAME, CHAIN_ID, CONTRACT, ENDPOINTS, HYPERION, SYM_RAW, TOKEN_CONTRACT } from "../config";
import type { ChunkedCiphertext, Ciphertext, Hex, TransferCiphertext } from "./crypto/types";
import { fromAsset, toAsset } from "./format";

export interface Session {
  auth: { actor: string; permission: string };
  transact(tx: { actions: unknown[] }, opts?: { broadcast?: boolean }): Promise<unknown>;
}

// @proton/web-sdk 5.x: app identity and theme live under `uiOptions`; `selectorOptions` only
// selects wallet types; `requestAccount` is required for the mobile deep-link return.
let link: ConnectWalletRet["link"] | null = null;

const sdkOptions = (restoreSession: boolean): ConnectWalletArgs => ({
  linkOptions: { chainId: CHAIN_ID, endpoints: ENDPOINTS, restoreSession },
  transportOptions: { requestAccount: CONTRACT, requestStatus: true },
  selectorOptions: { enabledWalletTypes: ["proton", "webauth", "anchor"] },
  uiOptions: { theme: "light", appInfo: { name: APP_NAME, logo: `${location.origin}/icon.svg`, logoRounded: true } },
});

const asSession = (r: ConnectWalletRet): Session | null => {
  if (!r.session) return null;
  return r.session as unknown as Session;
};

export async function login(): Promise<Session | null> {
  const ProtonWebSDK = await loadSdk();
  const r = await ProtonWebSDK(sdkOptions(false));
  if (r.error) throw r.error instanceof Error ? r.error : new Error(String(r.error));
  link = r.link ?? null;
  return asSession(r);
}

export async function restore(): Promise<Session | null> {
  try {
    const ProtonWebSDK = await loadSdk();
    const r = await ProtonWebSDK(sdkOptions(true));
    link = r.link ?? null;
    return asSession(r);
  } catch {
    return null;
  }
}

export async function logout(session: Session | null) {
  if (link && session) {
    try {
      await (link as unknown as { removeSession(app: string, auth: unknown, chainId: string): Promise<void> }).removeSession(APP_NAME, session.auth, CHAIN_ID);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- hex helpers

export const SYM = "4,XPR";
const hx = (bare: string): Hex => `0x${bare.toLowerCase()}` as Hex;
const bare = (h: string) => h.replace(/^0x/i, "").toLowerCase();

/** 256-B pair set (bare/0x hex) → ChunkedCiphertext */
export function parsePairSet(h: string): ChunkedCiphertext {
  const s = bare(h);
  if (s.length !== 512) throw new Error(`pair set must be 256 bytes, got ${s.length / 2}`);
  const pt = (o: number): Hex => hx(s.slice(o, o + 128));
  return { lo: { c: pt(0), d: pt(128) }, hi: { c: pt(256), d: pt(384) } };
}
export const pairSetHex = (ct: ChunkedCiphertext) => bare(ct.lo.c) + bare(ct.lo.d) + bare(ct.hi.c) + bare(ct.hi.d);

/** 512-B transfer set → TransferCiphertext */
export function parseTransferSet(h: string): TransferCiphertext {
  const s = bare(h);
  if (s.length !== 1024) throw new Error(`transfer set must be 512 bytes, got ${s.length / 2}`);
  const ch = (k: number) => {
    const o = k * 512;
    const pt = (i: number): Hex => hx(s.slice(o + i * 128, o + (i + 1) * 128));
    return { c: pt(0), dSender: pt(1), dReceiver: pt(2), dAuditor: pt(3) };
  };
  return { lo: ch(0), hi: ch(1) };
}
export const transferSetHex = (t: TransferCiphertext) =>
  [t.lo, t.hi].map((c) => bare(c.c) + bare(c.dSender) + bare(c.dReceiver) + bare(c.dAuditor)).join("");

/** the receiver's / auditor's view of a transfer set as a pair set */
export const receiverView = (t: TransferCiphertext): ChunkedCiphertext => ({ lo: { c: t.lo.c, d: t.lo.dReceiver }, hi: { c: t.hi.c, d: t.hi.dReceiver } });
export const auditorView = (t: TransferCiphertext): ChunkedCiphertext => ({ lo: { c: t.lo.c, d: t.lo.dAuditor }, hi: { c: t.hi.c, d: t.hi.dAuditor } });
export const senderView = (t: TransferCiphertext): ChunkedCiphertext => ({ lo: { c: t.lo.c, d: t.lo.dSender }, hi: { c: t.hi.c, d: t.hi.dSender } });

// ---------------------------------------------------------------- RPC reads

async function rpc<T>(path: string, body: unknown): Promise<T> {
  let lastErr: unknown;
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(`${ep}/v1/chain/${path}`, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Live public XPR balance (units). */
export async function getPublicBalance(actor: string): Promise<bigint> {
  const rows = await rpc<string[]>("get_currency_balance", { code: TOKEN_CONTRACT, account: actor, symbol: "XPR" });
  return rows.length ? fromAsset(rows[0]) : 0n;
}

export async function getInfo(): Promise<{ head_block_num: number; server_version_string: string }> {
  return rpc("get_info", {});
}

export async function accountExists(name: string): Promise<boolean> {
  try {
    await rpc("get_account", { account_name: name });
    return true;
  } catch {
    return false;
  }
}

export async function contractCodeHash(): Promise<string> {
  const r = await rpc<{ code_hash: string }>("get_code_hash", { account_name: CONTRACT });
  return r.code_hash;
}

export interface ConfAccountRow {
  owner: string;
  enc_pubkey: Hex;
  avail: ChunkedCiphertext;
  pending: ChunkedCiphertext;
  pending_count: number;
  nonce: string;
}
interface RawAccountRow {
  owner: string;
  enc_pubkey: string;
  avail: string;
  pending: string;
  pending_count: number;
  nonce: string | number;
}
const parseRow = (r: RawAccountRow): ConfAccountRow => ({
  owner: r.owner,
  enc_pubkey: hx(r.enc_pubkey),
  avail: parsePairSet(r.avail),
  pending: parsePairSet(r.pending),
  pending_count: Number(r.pending_count),
  nonce: String(r.nonce),
});

export async function getConfAccount(actor: string): Promise<ConfAccountRow | null> {
  const r = await rpc<{ rows: RawAccountRow[] }>("get_table_rows", {
    code: CONTRACT,
    scope: SYM_RAW,
    table: "accounts",
    lower_bound: actor,
    upper_bound: actor,
    limit: 1,
    json: true,
  });
  const row = r.rows[0];
  return row && row.owner === actor ? parseRow(row) : null;
}

/** every registered account (peers you can pay confidentially) */
export async function listConfAccounts(): Promise<ConfAccountRow[]> {
  const out: ConfAccountRow[] = [];
  let lower = "";
  for (let i = 0; i < 20; i++) {
    const r = await rpc<{ rows: RawAccountRow[]; more: boolean; next_key: string }>("get_table_rows", {
      code: CONTRACT,
      scope: SYM_RAW,
      table: "accounts",
      lower_bound: lower,
      limit: 100,
      json: true,
    });
    out.push(...r.rows.map(parseRow));
    if (!r.more) break;
    lower = r.next_key;
  }
  return out;
}

export interface ConfConfig {
  auditorPubkey: Hex;
  withdrawGranularity: bigint;
  depositGranularity: bigint;
  paused: boolean;
  tokenContract: string;
}
export async function getConfConfig(): Promise<ConfConfig | null> {
  const r = await rpc<{ rows: { sym: string | number; token_contract: string; auditor_pubkey: string; withdraw_granularity: string | number; deposit_granularity: string | number; paused: number | boolean }[] }>(
    "get_table_rows",
    { code: CONTRACT, scope: CONTRACT, table: "config", lower_bound: SYM_RAW, upper_bound: SYM_RAW, limit: 1, json: true }
  );
  const c = r.rows[0];
  if (!c) return null;
  return {
    auditorPubkey: hx(c.auditor_pubkey),
    withdrawGranularity: BigInt(c.withdraw_granularity),
    depositGranularity: BigInt(c.deposit_granularity),
    paused: !!c.paused,
    tokenContract: c.token_contract,
  };
}

// ---------------------------------------------------------------- Hyperion history

export interface PoolAction {
  ts: number;
  block: number;
  txid: string;
  seq: number;
  kind: "register" | "deposit" | "send" | "fold" | "withdraw" | "plain-transfer";
  from: string;
  to: string;
  /** deposits / withdrawals (public) */
  amount?: bigint;
  /** send */
  t?: TransferCiphertext;
  bNew?: ChunkedCiphertext;
  proof?: Hex;
}

interface HyperionAction {
  timestamp: string;
  block_num: number;
  trx_id: string;
  global_sequence: number;
  act: { account: string; name: string; data: Record<string, unknown> };
  receipts?: { receiver: string }[];
}

/** Every action that touched the pool, newest first (deduplicated by tx+seq). */
export async function poolHistory(limit = 200): Promise<PoolAction[]> {
  const url = `${HYPERION}/v2/history/get_actions?account=${CONTRACT}&limit=${limit}&sort=desc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`history: HTTP ${res.status}`);
  const d = (await res.json()) as { actions: HyperionAction[] };
  const seen = new Set<string>();
  const out: PoolAction[] = [];
  for (const a of d.actions) {
    const k = `${a.trx_id}/${a.global_sequence}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const ts = Date.parse(a.timestamp.endsWith("Z") ? a.timestamp : a.timestamp + "Z");
    const base = { ts, block: a.block_num, txid: a.trx_id, seq: a.global_sequence };
    const x = a.act.data;
    if (a.act.account === CONTRACT) {
      if (a.act.name === "send") {
        out.push({ ...base, kind: "send", from: String(x.from), to: String(x.to), t: parseTransferSet(String(x.t)), bNew: parsePairSet(String(x.b_new)), proof: hx(String(x.proof)) });
      } else if (a.act.name === "withdraw") {
        out.push({ ...base, kind: "withdraw", from: CONTRACT, to: String(x.owner), amount: fromAsset(String(x.quantity)) });
      } else if (a.act.name === "applypending") {
        out.push({ ...base, kind: "fold", from: String(x.owner), to: String(x.owner) });
      } else if (a.act.name === "register") {
        out.push({ ...base, kind: "register", from: String(x.owner), to: String(x.owner) });
      }
    } else if (a.act.account === TOKEN_CONTRACT && a.act.name === "transfer") {
      const from = String(x.from);
      const to = String(x.to);
      const memo = String(x.memo ?? "");
      const amount = fromAsset(String(x.quantity));
      if (to === CONTRACT && memo.startsWith("conf:")) out.push({ ...base, kind: "deposit", from, to: memo.slice(5), amount });
      else if (to === CONTRACT) out.push({ ...base, kind: "plain-transfer", from, to, amount });
      // withdrawals appear as the contract's own `withdraw` action (above); the inline token
      // transfer from the contract is the same event
    }
  }
  return out;
}

// ---------------------------------------------------------------- writes

const auth = (s: Session) => [{ actor: s.auth.actor, permission: s.auth.permission }];

export function registerAction(s: Session, encPubkey: Hex, _pok?: Hex) {
  return { account: CONTRACT, name: "register", authorization: auth(s), data: { owner: s.auth.actor, sym: SYM, enc_pubkey: bare(encPubkey) } };
}

/** deposit = plain token transfer into escrow with memo `conf:<owner>` */
export function depositAction(s: Session, amount: bigint) {
  return {
    account: TOKEN_CONTRACT,
    name: "transfer",
    authorization: auth(s),
    data: { from: s.auth.actor, to: CONTRACT, quantity: toAsset(amount), memo: `conf:${s.auth.actor}` },
  };
}

export function applyPendingAction(s: Session) {
  return { account: CONTRACT, name: "applypending", authorization: auth(s), data: { owner: s.auth.actor, sym: SYM } };
}

export function transferAction(s: Session, to: string, t: TransferCiphertext, newBalance: ChunkedCiphertext, proof: Hex) {
  return {
    account: CONTRACT,
    name: "send",
    authorization: auth(s),
    data: { from: s.auth.actor, sym: SYM, to, t: transferSetHex(t), b_new: pairSetHex(newBalance), proof: bare(proof) },
  };
}

export function withdrawAction(s: Session, amount: bigint, newBalance: ChunkedCiphertext, proof: Hex) {
  return {
    account: CONTRACT,
    name: "withdraw",
    authorization: auth(s),
    data: { owner: s.auth.actor, quantity: toAsset(amount), b_new: pairSetHex(newBalance), proof: bare(proof) },
  };
}

export async function broadcast(s: Session, actions: unknown[]): Promise<string> {
  const r = (await s.transact({ actions }, { broadcast: true })) as { processed?: { id?: string }; transaction_id?: string };
  return r.transaction_id ?? r.processed?.id ?? "";
}

export type { Ciphertext };
