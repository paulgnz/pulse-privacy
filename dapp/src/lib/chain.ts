// Chain access. Reads go straight to the testnet RPC. Writes go through the WebAuth session
// (`session.transact`); the action shapes follow docs/01-design.md §4.2 and are what the T3
// contract will accept. In mock mode the ConfidentialClient does not call the writers.
import ProtonWebSDK from "@proton/web-sdk";
import "@proton/link";
import { APP_NAME, CHAIN_ID, CONTRACT, ENDPOINTS, TOKEN_CONTRACT } from "../config";
import type { ChunkedCiphertext, Hex, TransferCiphertext } from "./crypto/types";
import { fromAsset, toAsset } from "./format";

export interface Session {
  auth: { actor: string; permission: string };
  transact(tx: { actions: unknown[] }, opts?: { broadcast?: boolean }): Promise<unknown>;
}

type AnyLink = { removeSession(app: never, auth: never, chainId: never): Promise<void> } | null | undefined;
let link: AnyLink = null;

const sdkOptions = (restoreSession: boolean) => ({
  linkOptions: { chainId: CHAIN_ID, endpoints: ENDPOINTS, restoreSession },
  transportOptions: { requestAccount: CONTRACT, requestStatus: true },
  selectorOptions: { appName: APP_NAME, enabledWalletTypes: ["proton", "webauth", "anchor"] },
});

export async function login(): Promise<Session | null> {
  const r = (await ProtonWebSDK(sdkOptions(false) as never)) as unknown as { link: AnyLink; session: Session | null };
  link = r.link;
  return r.session;
}

export async function restore(): Promise<Session | null> {
  try {
    const r = (await ProtonWebSDK(sdkOptions(true) as never)) as unknown as { link: AnyLink; session: Session | null };
    link = r.link;
    return r.session ?? null;
  } catch {
    return null;
  }
}

export async function logout(session: Session | null) {
  if (link && session) {
    try {
      await link.removeSession(APP_NAME as never, session.auth as never, CHAIN_ID as never);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- reads

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

/** Confidential account row as the T3 contract will store it (null until T3 is deployed). */
export interface ConfAccountRow {
  owner: string;
  enc_pubkey: Hex;
  avail: ChunkedCiphertext;
  pending: ChunkedCiphertext;
  pending_count: number;
  nonce: string;
}

export async function getConfAccount(actor: string): Promise<ConfAccountRow | null> {
  try {
    const r = await rpc<{ rows: ConfAccountRow[] }>("get_table_rows", {
      code: CONTRACT,
      scope: "XPR",
      table: "accounts",
      lower_bound: actor,
      upper_bound: actor,
      limit: 1,
      json: true,
    });
    return r.rows[0] ?? null;
  } catch {
    return null; // table does not exist until T3
  }
}

// ---------------------------------------------------------------- writes (§4.2)

const auth = (s: Session) => [{ actor: s.auth.actor, permission: s.auth.permission }];

export function registerAction(s: Session, encPubkey: Hex, pok: Hex) {
  return { account: CONTRACT, name: "register", authorization: auth(s), data: { owner: s.auth.actor, enc_pubkey: encPubkey, pok } };
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
  return { account: CONTRACT, name: "applypending", authorization: auth(s), data: { owner: s.auth.actor } };
}

export function transferAction(s: Session, to: string, t: TransferCiphertext, newBalance: ChunkedCiphertext, proof: Hex) {
  return {
    account: CONTRACT,
    name: "transfer",
    authorization: auth(s),
    data: { from: s.auth.actor, to, t, b_new: newBalance, proof },
  };
}

export function withdrawAction(s: Session, amount: bigint, newBalance: ChunkedCiphertext, proof: Hex) {
  return {
    account: CONTRACT,
    name: "withdraw",
    authorization: auth(s),
    data: { owner: s.auth.actor, amount: toAsset(amount), b_new: newBalance, proof },
  };
}

export async function broadcast(s: Session, actions: unknown[]): Promise<string> {
  const r = (await s.transact({ actions }, { broadcast: true })) as { processed?: { id?: string }; transaction_id?: string };
  return r.transaction_id ?? r.processed?.id ?? "";
}
