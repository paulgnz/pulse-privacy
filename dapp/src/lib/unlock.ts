// "Your wallet is the key": derive the encryption secret from a WebAuth signature over a fixed,
// never-broadcast transaction. Standard XPR keys (K1, RFC 6979) sign deterministically, so the
// same account always yields the same secret on any device and there is nothing to back up.
// Hardware / WebAuthn keys randomise signatures; `unlock` detects that by signing twice and
// reports `deterministic: false` so the UI can fall back to a saved key.
import { CHAIN_ID, CONTRACT } from "../config";
import type { Session } from "./chain";
import { watchPopup } from "./chain";
import type { Hex } from "./crypto/types";

/** Baby Jubjub prime-order subgroup size (scalar field of the encryption keys). */
const SUBGROUP_ORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const DOMAIN = "pulse-privacy/elgamal/v1";

/** Shown by the wallet in the signing prompt. Part of the signed message: changing it changes the key. */
// Signed texts: part of the key derivation. Never change these strings; a changed text is a different key.
export const VIEWKEY_NOTE = "Derives your Confidential XPR viewing key on private.protonnz.com. Never sent to the chain. Moves nothing.";

/** Shown by the wallet when deriving the shielded spending key: a different message, so a different key. */
export const SHIELD_NOTE = "Derives your shielded spending key for Confidential XPR (testnet). Never sent to the chain. Moves nothing.";

/** The fixed transaction. Every field is constant so the signing digest is constant. */
export function unlockTransaction(actor: string, permission: string, legacy = false, contract = CONTRACT, note = VIEWKEY_NOTE) {
  const action = legacy
    ? { account: contract, name: "unlock", authorization: [{ actor, permission }], data: { owner: actor } }
    : { account: contract, name: "viewkey", authorization: [{ actor, permission }], data: { owner: actor, note } };
  return {
    expiration: "2035-01-01T00:00:00",
    ref_block_num: 0,
    ref_block_prefix: 0,
    max_net_usage_words: 0,
    max_cpu_usage_ms: 0,
    delay_sec: 0,
    context_free_actions: [],
    actions: [action],
    transaction_extensions: [],
  };
}

type TransactFn = (args: { transaction: unknown }, opts: { broadcast: boolean }) => Promise<{ signatures: { toString(): string }[] }>;

async function signOnce(session: Session, legacy = false, contract = CONTRACT, note = VIEWKEY_NOTE): Promise<string> {
  const r = await watchPopup(() => (session.transact as unknown as TransactFn)({ transaction: unlockTransaction(session.auth.actor, session.auth.permission, legacy, contract, note) }, { broadcast: false }));
  const sig = r.signatures?.[0];
  if (!sig) throw new Error("The wallet returned no signature.");
  return sig.toString();
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

/** secret = SHA-256(domain ‖ chainId ‖ actor ‖ signature) expanded to 512 bits, reduced mod l. */
export async function deriveSecret(signature: string, actor: string, domain = DOMAIN): Promise<Hex> {
  const enc = new TextEncoder();
  const seed = enc.encode(`${domain}|${CHAIN_ID}|${actor}|${signature}`);
  const h1 = await sha256(seed);
  const h2 = await sha256(new Uint8Array([...h1, 1]));
  const bytes = new Uint8Array([...h1, ...h2]);
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  const s = (x % (SUBGROUP_ORDER - 1n)) + 1n; // in [1, l)
  return `0x${s.toString(16).padStart(64, "0")}` as Hex;
}

/**
 * One signature, one popup. Browsers only allow a wallet popup inside a user click, so callers
 * must invoke this directly from a click handler and never chain two calls from one click.
 * First-time setup calls it twice from two separate clicks and compares the signatures.
 */
/** the shielded spending key: one signature over xprshield::viewkey, its own domain in the hash */
export async function unlockShield(session: Session, contract: string): Promise<bigint> {
  const signature = await signOnce(session, false, contract, SHIELD_NOTE);
  const secret = await deriveSecret(signature, session.auth.actor, "pulse-privacy/shield/v1");
  return BigInt(secret);
}

export async function unlockOnce(session: Session, legacy = false): Promise<{ signature: string; secret: Hex }> {
  const signature = await signOnce(session, legacy);
  return { signature, secret: await deriveSecret(signature, session.auth.actor) };
}

/**
 * @deprecated chains two popups from one click (blocked by browsers); use `unlockOnce` twice.
 */
export async function unlock(session: Session, onStage?: (stage: string) => void, check = true): Promise<{ secret: Hex; deterministic: boolean }> {
  onStage?.("Waiting for your wallet");
  const a = await signOnce(session);
  let deterministic = true;
  if (check) {
    onStage?.("Confirming the signature is stable");
    const b = await signOnce(session);
    deterministic = a === b;
  }
  onStage?.("Deriving your key");
  const secret = await deriveSecret(a, session.auth.actor);
  return { secret, deterministic };
}
