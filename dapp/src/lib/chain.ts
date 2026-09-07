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
import { APP_NAME, CHAIN_ID, CONTRACT, ENDPOINTS, HYPERIONS } from "../config";
import type { ChunkedCiphertext, Ciphertext, Hex, TransferCiphertext } from "./crypto/types";
import { assetCode, fromAsset, toAsset } from "./format";
import { XPR, sortTokens, tokenFromRaw, type Token } from "./token";
import { decompressHex, ptHex } from "./crypto/babyjub";

/** keys are stored compressed (32 B) on chain, or full (64 B) for rows registered earlier */
const fullKey = (h: string): Hex => hx(ptHex(decompressHex(h)));

export interface Session {
  auth: { actor: string; permission: string };
  transact(tx: { actions: unknown[] }, opts?: { broadcast?: boolean }): Promise<unknown>;
  /** the wallet's signing key, "PUB_K1_…" or "PUB_R1_…"/"PUB_WA_…", when the link reports it */
  publicKey?: string;
}

/** K1 (secp256k1) signatures from WebAuth are deterministic, so the derived key is stable without a second signature. */
export const deterministicSigner = (s: Session): boolean => !!s.publicKey && s.publicKey.startsWith("PUB_K1_");

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
  const s = r.session as unknown as Session & { publicKey?: { toString(): string } };
  const pk = s.publicKey ? String(s.publicKey) : undefined;
  return Object.assign(s, { publicKey: pk }) as Session;
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
      const res = await fetch(`${ep}/v1/chain/${path}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Live public balance of `token` (units). */
export async function getPublicBalance(actor: string, token: Token = XPR): Promise<bigint> {
  const rows = await rpc<string[]>("get_currency_balance", { code: token.contract, account: actor, symbol: token.code });
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
  enc_pubkey: fullKey(r.enc_pubkey),
  avail: parsePairSet(r.avail),
  pending: parsePairSet(r.pending),
  pending_count: Number(r.pending_count),
  nonce: String(r.nonce),
});

/** The account's encryption key from any configured token (register once, receive any token). */
export async function findKeyAnywhere(actor: string): Promise<{ pubkey: Hex; token: Token } | null> {
  const tokens = await listTokens().catch(() => [XPR]);
  for (const t of tokens) {
    const row = await getConfAccount(actor, t).catch(() => null);
    if (row) return { pubkey: row.enc_pubkey, token: t };
  }
  return null;
}

export async function getConfAccount(actor: string, token: Token = XPR): Promise<ConfAccountRow | null> {
  const r = await rpc<{ rows: RawAccountRow[] }>("get_table_rows", {
    code: CONTRACT,
    scope: token.raw,
    table: "accounts",
    lower_bound: actor,
    upper_bound: actor,
    limit: 1,
    json: true,
  });
  const row = r.rows[0];
  return row && row.owner === actor ? parseRow(row) : null;
}

/** every account registered for `token` (peers you can pay confidentially) */
export async function listConfAccounts(token: Token = XPR): Promise<ConfAccountRow[]> {
  const out: ConfAccountRow[] = [];
  let lower = "";
  for (let i = 0; i < 20; i++) {
    const r = await rpc<{ rows: RawAccountRow[]; more: boolean; next_key: string }>("get_table_rows", {
      code: CONTRACT,
      scope: token.raw,
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
  token: Token;
  auditorPubkey: Hex;
  withdrawGranularity: bigint;
  depositGranularity: bigint;
  paused: boolean;
  tokenContract: string;
}
interface RawConfigRow {
  sym: string | number;
  token_contract: string;
  auditor_pubkey: string;
  withdraw_granularity: string | number;
  deposit_granularity: string | number;
  paused: number | boolean;
}
const parseConfig = (c: RawConfigRow): ConfConfig => ({
  token: tokenFromRaw(c.sym, c.token_contract),
  auditorPubkey: fullKey(c.auditor_pubkey),
  withdrawGranularity: BigInt(c.withdraw_granularity),
  depositGranularity: BigInt(c.deposit_granularity),
  paused: !!c.paused,
  tokenContract: c.token_contract,
});

export async function getConfConfig(token: Token = XPR): Promise<ConfConfig | null> {
  const r = await rpc<{ rows: RawConfigRow[] }>("get_table_rows", {
    code: CONTRACT, scope: CONTRACT, table: "config", lower_bound: token.raw, upper_bound: token.raw, limit: 1, json: true,
  });
  const c = r.rows[0];
  return c && String(c.sym) === token.raw ? parseConfig(c) : null;
}

/** every token the contract is configured for (one `config` row each), XPR first */
export async function listTokens(): Promise<Token[]> {
  const r = await rpc<{ rows: RawConfigRow[] }>("get_table_rows", { code: CONTRACT, scope: CONTRACT, table: "config", limit: 100, json: true });
  return sortTokens(r.rows.map((c) => parseConfig(c).token));
}

/** Soft-launch limits per token (units): per-deposit cap, pool cap and the pool's current size. 0 = no cap. */
export interface PoolLimits { token: Token; maxPool: bigint; maxDeposit: bigint; pool: bigint; withdrawGranularity: bigint }
export async function listLimits(): Promise<PoolLimits[]> {
  const [cfg, lim] = await Promise.all([
    rpc<{ rows: RawConfigRow[] }>("get_table_rows", { code: CONTRACT, scope: CONTRACT, table: "config", limit: 100, json: true }),
    rpc<{ rows: { sym: string | number; max_pool: string | number; max_deposit: string | number; pool: string | number }[] }>("get_table_rows", { code: CONTRACT, scope: CONTRACT, table: "limits", limit: 100, json: true }),
  ]);
  const out: PoolLimits[] = [];
  for (const c of cfg.rows) {
    const p = parseConfig(c);
    const l = lim.rows.find((r) => String(r.sym) === String(c.sym));
    out.push({ token: p.token, withdrawGranularity: p.withdrawGranularity, maxPool: BigInt(l?.max_pool ?? 0), maxDeposit: BigInt(l?.max_deposit ?? 0), pool: BigInt(l?.pool ?? 0) });
  }
  return sortTokens(out.map((o) => o.token)).map((t) => out.find((o) => o.token.code === t.code)!);
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
  /** the raw `t` hex as the indexer gave it, for confirmation against the block */
  tRaw?: string;
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
const sendCache = new Map<string, Record<string, unknown> | null>();
/** decoded `send` data straight from the block (current ABI), or null if not found */
export async function sendDataFromChain(blockNum: number, trxId: string): Promise<Record<string, unknown> | null> {
  if (sendCache.has(trxId)) return sendCache.get(trxId) ?? null;
  try {
    const b = await rpc<{ transactions: { trx: { id?: string; transaction?: { actions: { account: string; name: string; data: Record<string, unknown> }[] } } | string }[] }>("get_block", { block_num_or_id: blockNum });
    let found: Record<string, unknown> | null = null;
    for (const t of b.transactions) {
      if (typeof t.trx === "string" || t.trx.id !== trxId || !t.trx.transaction) continue;
      const act = t.trx.transaction.actions.find((x) => x.account === CONTRACT && x.name === "send");
      if (act && typeof act.data === "object") found = act.data;
    }
    sendCache.set(trxId, found);
    return found;
  } catch {
    return null;
  }
}

const confirmed = new Map<string, boolean>();
/**
 * Is this incoming `send`, with exactly this ciphertext, really in that block? Indexer data
 * is trusted for display only; a spoofed indexer could otherwise show a payment that never
 * happened, or a real one with a different amount. Checked once per transaction against the
 * chain's own block. "unknown" means the chain could not be asked in time; the caller labels
 * the row and asks again next refresh.
 */
export async function confirmSend(blockNum: number, trxId: string, from: string, to: string, tRaw: string | undefined): Promise<"yes" | "no" | "unknown"> {
  const hit = confirmed.get(trxId);
  if (hit !== undefined) return hit ? "yes" : "no";
  const data = await Promise.race([sendDataFromChain(blockNum, trxId), new Promise<null | undefined>((r) => setTimeout(() => r(undefined), 6000))]);
  if (data === undefined) return "unknown";
  const chainT = String(data?.t ?? "").replace(/^0x/i, "").toLowerCase();
  const ok = !!data && String(data.from) === from && String(data.to) === to && !!tRaw && chainT === tRaw;
  confirmed.set(trxId, ok);
  return ok ? "yes" : "no";
}

export async function poolHistory(limit = 200, token: Token = XPR): Promise<PoolAction[]> {
  // Hyperion failover: first endpoint that answers wins
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (const h of HYPERIONS) {
    try {
      const r = await fetch(`${h}/v2/history/get_actions?account=${CONTRACT}&limit=${limit}&sort=desc`, { signal: AbortSignal.timeout(12000) });
      if (r.ok) { res = r; break; }
      lastErr = new Error(`${h}: HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  if (!res) throw lastErr instanceof Error ? lastErr : new Error("no Hyperion endpoint answered");
  if (!res.ok) throw new Error(`history: HTTP ${res.status}`);
  const d = (await res.json()) as { actions: HyperionAction[] };
  // Indexers decode with whatever ABI they cached; the chain decodes with the current one.
  // For `send`, take the action data from the block itself (cached per transaction).
  const badSend = (a: HyperionAction) =>
    a.act.account === CONTRACT && a.act.name === "send" && String(a.act.data.t ?? "").replace(/^0x/i, "").length !== 1024;
  await Promise.all(
    d.actions.filter(badSend).map(async (a) => {
      const fresh = await sendDataFromChain(a.block_num, a.trx_id);
      if (fresh) a.act.data = fresh;
    })
  );
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
      // contract actions carry the symbol ("4,XPR") or an asset; keep only this token's
      const symOk = x.sym === undefined || String(x.sym) === token.symStr;
      if (!symOk) continue;
      if (a.act.name === "withdraw" && assetCode(String(x.quantity ?? "")) !== token.code) continue;
      if (a.act.name === "send") {
        // One unreadable row must not empty the whole ledger. Actions from before the
        // key-compression change decode under the current ABI with shifted fields
        // (ps ← t, pr ← b_new, pa ← proof); recover that layout.
        try {
          let t = String(x.t ?? ""), bNew = String(x.b_new ?? ""), proof = String(x.proof ?? "");
          if (t.replace(/^0x/i, "").length !== 1024 && String(x.ps ?? "").replace(/^0x/i, "").length === 1024) {
            t = String(x.ps); bNew = String(x.pr); proof = String(x.pa);
          }
          out.push({ ...base, kind: "send", from: String(x.from), to: String(x.to), t: parseTransferSet(t), tRaw: t.replace(/^0x/i, "").toLowerCase(), bNew: parsePairSet(bNew), proof: hx(proof) });
        } catch (e) {
          console.warn("history: skipping unreadable send", a.trx_id, (e as Error).message);
        }
      } else if (a.act.name === "withdraw") {
        out.push({ ...base, kind: "withdraw", from: CONTRACT, to: String(x.owner), amount: fromAsset(String(x.quantity)) });
      } else if (a.act.name === "applypending") {
        out.push({ ...base, kind: "fold", from: String(x.owner), to: String(x.owner) });
      } else if (a.act.name === "register") {
        out.push({ ...base, kind: "register", from: String(x.owner), to: String(x.owner) });
      }
    } else if (a.act.account === token.contract && a.act.name === "transfer" && assetCode(String(x.quantity ?? "")) === token.code) {
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

export function registerAction(s: Session, token: Token, encPubkey: Hex) {
  return { account: CONTRACT, name: "register", authorization: auth(s), data: { owner: s.auth.actor, sym: token.symStr, enc_pubkey: bare(encPubkey) } };
}

/** deposit = plain token transfer into escrow with memo `conf:<owner>` */
export function depositAction(s: Session, token: Token, amount: bigint) {
  return {
    account: token.contract,
    name: "transfer",
    authorization: auth(s),
    data: { from: s.auth.actor, to: CONTRACT, quantity: toAsset(amount, token), memo: `conf:${s.auth.actor}` },
  };
}

export function recoveryAction(s: Session, blob: Hex) {
  return { account: CONTRACT, name: "setrecovery", authorization: auth(s), data: { owner: s.auth.actor, blob: bare(blob) } };
}

/** whether the account keeps an encrypted recovery copy of its secret with the committee */
export async function hasRecovery(actor: string): Promise<boolean> {
  const r = await rpc<{ rows: { owner: string }[] }>("get_table_rows", { code: CONTRACT, scope: CONTRACT, table: "recovery", lower_bound: actor, upper_bound: actor, limit: 1, json: true });
  return r.rows.length > 0 && r.rows[0].owner === actor;
}

export function applyPendingAction(s: Session, token: Token) {
  return { account: CONTRACT, name: "applypending", authorization: auth(s), data: { owner: s.auth.actor, sym: token.symStr } };
}

/** `ps`/`pr`/`pa`: full sender / receiver / auditor pubkeys; the contract stores them compressed and checks these. */
export function transferAction(s: Session, token: Token, to: string, t: TransferCiphertext, newBalance: ChunkedCiphertext, proof: Hex, ps: Hex, pr: Hex, pa: Hex) {
  return {
    account: CONTRACT,
    name: "send",
    authorization: auth(s),
    data: { from: s.auth.actor, sym: token.symStr, to, ps: bare(ps), pr: bare(pr), pa: bare(pa), t: transferSetHex(t), b_new: pairSetHex(newBalance), proof: bare(proof) },
  };
}

/** `po`/`pa`: full owner / auditor pubkeys (see `transferAction`). */
export function withdrawAction(s: Session, token: Token, amount: bigint, newBalance: ChunkedCiphertext, proof: Hex, po: Hex, pa: Hex) {
  return {
    account: CONTRACT,
    name: "withdraw",
    authorization: auth(s),
    data: { owner: s.auth.actor, quantity: toAsset(amount, token), po: bare(po), pa: bare(pa), b_new: pairSetHex(newBalance), proof: bare(proof) },
  };
}

/** Chain and wallet errors, in the user's terms. */
export function friendlyError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  const m = raw.toLowerCase();
  if (m.includes("insufficient ram")) return new Error("Your account needs a little more RAM (about 1 KB per token you register). Buy RAM at resources.xprnetwork.org, then try again.");
  if (m.includes("executing for too long") || m.includes("tx_cpu_usage_exceeded") || m.includes("deadline exceeded")) return new Error("The network node was slow and gave up on the transaction. Nothing was sent. Try again.");
  if (m.includes("closed") || m.includes("cancel") || m.includes("rejected")) return new Error("Signing was cancelled in the wallet.");
  if (m.includes("unable to reach") || m.includes("failed to fetch") || m.includes("networkerror")) return new Error("Could not reach the network. Check your connection and try again.");
  const assertion = raw.match(/assertion failure with message: ([^"\n]+)/i);
  if (assertion) return new Error(assertion[1].trim());
  return e instanceof Error ? e : new Error(raw);
}

export async function broadcast(s: Session, actions: unknown[]): Promise<string> {
  try {
    const r = (await s.transact({ actions }, { broadcast: true })) as { processed?: { id?: string }; transaction_id?: string };
    return r.transaction_id ?? r.processed?.id ?? "";
  } catch (e) {
    throw friendlyError(e);
  }
}

export type { Ciphertext };
