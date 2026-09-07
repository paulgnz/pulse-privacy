import { NETWORK } from "../config";
// Encryption key custody for the testnet dapp: generated here, kept in localStorage, exported
// and imported by the user. Losing it means losing the ability to read AND spend the
// confidential balance (docs/01-design.md §2.7). In production this key is derived from the
// wallet seed inside WebAuth; the dapp never sends it anywhere.
import type { CryptoBackend, EncryptionKeypair, Hex } from "./crypto/types";

const KEY = (actor: string) => `pulse-privacy/enckey/v1/${actor}`;

export function loadKeypair(actor: string): EncryptionKeypair | null {
  try {
    const raw = localStorage.getItem(KEY(actor));
    if (!raw) return null;
    const kp = JSON.parse(raw) as EncryptionKeypair;
    if (!/^0x[0-9a-f]{64}$/.test(kp.secret) || !/^0x[0-9a-f]+$/.test(kp.pubkey)) return null;
    return kp;
  } catch {
    return null;
  }
}

export function saveKeypair(actor: string, kp: EncryptionKeypair) {
  localStorage.setItem(KEY(actor), JSON.stringify(kp));
}

export function forgetKeypair(actor: string) {
  localStorage.removeItem(KEY(actor));
}

const BACKED_UP = (actor: string) => `pulse-privacy/backedup/v1/${actor}`;
export const markBackedUp = (actor: string) => { try { localStorage.setItem(BACKED_UP(actor), "1"); } catch { /* ignore */ } };
export const isBackedUp = (actor: string) => { try { return localStorage.getItem(BACKED_UP(actor)) === "1"; } catch { return false; } };

/**
 * An encrypted copy of the secret that only the auditor's viewing key opens (96 bytes:
 * R = r·P_a as a full point, then secret XOR sha256(r·H)). The committee can return it to the
 * account's owner if this browser's copy is lost. It gives the committee nothing it does not
 * already have: it can read every amount with the viewing key, and spending still needs the
 * wallet's own signature.
 */
export async function recoveryBlob(secret: Hex, auditorPubkey: Hex): Promise<Hex> {
  const { H, mul, ptFromHex, ptHex, randScalar } = await import("./crypto/babyjub");
  const r = randScalar();
  const R = mul(ptFromHex(auditorPubkey.replace(/^0x/, "")), r);
  const K = mul(H, r);
  const keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ptHex(K))));
  const s = secret.replace(/^0x/, "").padStart(64, "0");
  let ct = "";
  for (let i = 0; i < 32; i++) ct += (parseInt(s.slice(i * 2, i * 2 + 2), 16) ^ keyBytes[i]).toString(16).padStart(2, "0");
  return `0x${ptHex(R)}${ct}` as Hex;
}

export async function createKeypair(actor: string, backend: CryptoBackend): Promise<EncryptionKeypair> {
  const kp = await backend.generateKeypair();
  saveKeypair(actor, kp);
  return kp;
}

export async function importSecret(actor: string, backend: CryptoBackend, secretInput: string, expectedPubkey?: Hex): Promise<EncryptionKeypair> {
  const s = secretInput.trim().toLowerCase();
  const secret = (s.startsWith("0x") ? s : `0x${s}`) as Hex;
  if (!/^0x[0-9a-f]{64}$/.test(secret)) throw new Error("a secret is 32 bytes of hex");
  const kp = { secret, pubkey: await backend.pubkeyOf(secret) };
  if (expectedPubkey && kp.pubkey.toLowerCase() !== expectedPubkey.toLowerCase()) throw new Error("that secret does not produce the key registered for this account, so it was not saved");
  saveKeypair(actor, kp);
  return kp;
}

/** Export file body (JSON) the user downloads or copies. */
export function exportBlob(actor: string, kp: EncryptionKeypair): string {
  return JSON.stringify(
    {
      format: "pulse-privacy/enckey/v1",
      account: actor,
      network: `xpr-${NETWORK}`,
      secret: kp.secret,
      pubkey: kp.pubkey,
      warning: "Anyone with this secret can read your confidential balance and history. Losing it means you cannot read or spend it.",
    },
    null,
    2
  );
}
