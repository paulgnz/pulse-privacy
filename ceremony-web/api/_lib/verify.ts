// Attestation check: the contributor signed the never-broadcast `xprconf::viewkey(owner, note)`
// transaction with note = "ceremony/<phase>/<index>/<output sha256>". We recover the signing
// key from the signature over the transaction's signing digest and require it to be one of
// the account's active or owner keys on XPR mainnet.
import { PublicKey, Signature, Transaction } from "@greymass/eosio";

export const CHAIN_ID = "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0";
export const RPCS = ["https://api.protonnz.com", "https://proton.eosusa.io", "https://proton.cryptolions.io"];
export const CONTRACT = "xprconf";

export const noteFor = (phase: number, index: number, sha256: string) => `ceremony/${phase}/${index}/${sha256}`;
export const lockNoteFor = (phase: number, index: number, ts: number) => `ceremony/lock/${phase}/${index}/${ts}`;

/** the exact transaction the browser signs (must match the client byte for byte) */
export function attestationTransaction(actor: string, permission: string, note: string) {
  return {
    expiration: "2035-01-01T00:00:00",
    ref_block_num: 0,
    ref_block_prefix: 0,
    max_net_usage_words: 0,
    max_cpu_usage_ms: 0,
    delay_sec: 0,
    context_free_actions: [],
    actions: [{ account: CONTRACT, name: "viewkey", authorization: [{ actor, permission }], data: { owner: actor, note } }],
    transaction_extensions: [],
  };
}

const VIEWKEY_ABI = {
  version: "eosio::abi/1.2",
  types: [],
  structs: [{ name: "viewkey", base: "", fields: [{ name: "owner", type: "name" }, { name: "note", type: "string" }] }],
  actions: [{ name: "viewkey", type: "viewkey", ricardian_contract: "" }],
  tables: [],
  ricardian_clauses: [],
  variants: [],
};

async function rpc<T>(path: string, body: unknown): Promise<T> {
  let last: unknown = null;
  for (const ep of RPCS) {
    try {
      const r = await fetch(`${ep}/v1/chain/${path}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (r.ok) return (await r.json()) as T;
      last = new Error(`${ep}: ${r.status}`);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("no RPC");
}

export async function accountKeys(actor: string): Promise<string[]> {
  const a = await rpc<{ permissions: { perm_name: string; required_auth: { keys: { key: string }[] } }[] }>("get_account", { account_name: actor });
  const keys: string[] = [];
  for (const p of a.permissions) {
    if (p.perm_name !== "active" && p.perm_name !== "owner") continue;
    for (const k of p.required_auth.keys) {
      // WebAuthn (PUB_WA_) keys cannot sign this transaction and the library does not parse them; skip them
      try {
        keys.push(PublicKey.from(k.key).toString());
      } catch {
        /* unsupported key type */
      }
    }
  }
  if (!keys.length) throw new Error(`${actor} has no K1 or R1 key on active or owner`);
  return keys;
}

/** returns the recovered key if the signature is by one of the account's keys, else throws */
export async function verifyAttestation(actor: string, permission: string, note: string, signature: string): Promise<string> {
  const tx = Transaction.from(attestationTransaction(actor, permission, note), [{ contract: CONTRACT, abi: VIEWKEY_ABI }]);
  const digest = tx.signingDigest(CHAIN_ID);
  const recovered = Signature.from(signature).recoverDigest(digest).toString();
  const keys = await accountKeys(actor);
  if (!keys.includes(recovered)) throw new Error(`signature is not by ${actor}'s active or owner key`);
  return recovered;
}
