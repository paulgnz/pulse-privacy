// Recovery copies of the shielded key, stored on chain in the `backups` table:
//  - the phrase copy: the key under a passphrase (the confidential site's scheme, AES-GCM with
//    600,000 PBKDF2 rounds), which only the owner's words open;
//  - the committee copy: the key sealed to the auditor's public key with the note scheme, so the
//    committee can return it after the owner proves they own the account. It gives the committee
//    nothing new: its key already opens every note, and spending still needs the wallet.
import { NETWORK } from "../../config";
import type { Pt } from "../crypto/babyjub";
import type { Hex } from "../crypto/types";
import { openPassphraseBlob, passphraseBlob } from "../keys";
import { compressPoint, decompressPoint, hex32, openSealed, sealTo, words } from "./notes";

/** 76 bytes, hex without 0x, for `setbackup` */
export async function phraseCopy(ask: bigint, passphrase: string): Promise<string> {
  return (await passphraseBlob(("0x" + hex32(ask)) as Hex, passphrase)).replace(/^0x/, "");
}
export async function openPhraseCopy(blob: string, passphrase: string): Promise<bigint> {
  return BigInt(await openPassphraseBlob(blob, passphrase));
}

/** 64 bytes, hex: the ephemeral point compressed, then the masked key */
export function committeeCopy(ask: bigint, auditorPk: Pt): string {
  const { epk, c } = sealTo(auditorPk, ask);
  return hex32(compressPoint(epk)) + hex32(c);
}
export function openCommitteeCopy(blob: string, auditorAsk: bigint): bigint {
  const [w, c] = words(blob);
  return openSealed(auditorAsk, decompressPoint(w), c);
}

/** the key file: the raw key with enough context to know what it is */
export function shieldKeyFile(actor: string, ask: bigint): string {
  return JSON.stringify({
    format: "pulse-privacy/shieldkey/v1",
    account: actor,
    network: `xpr-${NETWORK}`,
    secret: "0x" + hex32(ask),
    warning: "Anyone with this secret can read your shielded notes. Spending still needs your wallet.",
  }, null, 2);
}

/** a pasted secret: the key file's JSON, or 64 hex characters with or without 0x */
export function parseSecretInput(input: string): bigint {
  let t = input.trim();
  if (t.startsWith("{")) {
    try { t = String((JSON.parse(t) as { secret?: string }).secret ?? ""); } catch { throw new Error("That is not a key file."); }
  }
  t = t.replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(t)) throw new Error("A secret is 64 hexadecimal characters, or the key file.");
  return BigInt("0x" + t);
}
