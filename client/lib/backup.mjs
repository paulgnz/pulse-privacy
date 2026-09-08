// Recovery copies, byte-compatible with the app: the phrase copy (AES-GCM under a passphrase
// stretched with 600,000 rounds of PBKDF2-SHA256; 16-byte salt, 12-byte nonce, 76 bytes in
// all) and the committee copy (the key sealed to the committee's public key with the note
// scheme: compressed ephemeral point, then the masked key; 64 bytes).
import { randomInt, webcrypto } from "node:crypto";
import N from "../../circuits/lib/notes.mjs";
import { WORDS } from "./words.mjs";

const subtle = webcrypto.subtle;
const ROUNDS = 600_000;
const enc = new TextEncoder();
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/../g).map((b) => parseInt(b, 16)));

export function generatePhrase() {
  return Array.from({ length: 7 }, () => WORDS[randomInt(WORDS.length)]).join(" ");
}
export function passphraseProblem(p) {
  const s = p.trim();
  if (s.length < 14) return "use at least 14 characters, or the generated phrase";
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  if (s.split(/\s+/).filter(Boolean).length < 4 && kinds < 3) return "use four or more words, or mix letters, numbers and symbols";
  return null;
}
async function passKey(passphrase, salt) {
  const base = await subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ROUNDS }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
/** 76 bytes as hex without 0x */
export async function phraseCopy(ask, passphrase) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await passKey(passphrase, salt);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, fromHex(N.hex32(ask))));
  return toHex(salt) + toHex(nonce) + toHex(ct);
}
export async function openPhraseCopy(blobHex, passphrase) {
  const b = fromHex(blobHex);
  if (b.length !== 76) throw new Error("unexpected recovery copy format");
  const key = await passKey(passphrase, b.slice(0, 16));
  try {
    const pt = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: b.slice(16, 28) }, key, b.slice(28)));
    return BigInt("0x" + toHex(pt));
  } catch { throw new Error("those words do not open the recovery copy"); }
}
/** 64 bytes as hex */
export function committeeCopy(ask, auditorPk) {
  const { epk, c } = N.sealTo(auditorPk, ask);
  return N.hex32(N.compressPoint(epk)) + N.hex32(c);
}
export function openCommitteeCopy(blobHex, auditorAsk) {
  const w = (blobHex.match(/.{64}/g) ?? []).map((x) => BigInt("0x" + x));
  return N.openSealed(auditorAsk, N.decompressPoint(w[0]), w[1]);
}
