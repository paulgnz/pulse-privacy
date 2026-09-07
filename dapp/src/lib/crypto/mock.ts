// MOCK crypto backend. Deterministic, dependency-free, and clearly not secure: a keyed
// xorshift stream stands in for twisted ElGamal, and "proofs" are hashes of the inputs. It
// exists so the whole UI flow runs today. T2 replaces this file with the real Baby Jubjub
// ElGamal + Groth16 prover (arkworks via wasm-bindgen or snarkjs) behind the same interface.
import type {
  ChunkedCiphertext,
  CryptoBackend,
  EncryptionKeypair,
  Hex,
  ProgressFn,
  TransferCiphertext,
  TransferProofInput,
  TransferProofOutput,
  WithdrawProofInput,
  WithdrawProofOutput,
} from "./types";

const hex = (bytes: Uint8Array): Hex => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
const unhex = (h: string): Uint8Array => {
  const s = h.replace(/^0x/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

async function sha256(...parts: (Uint8Array | string)[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

/** Mock "public key": a hash of the secret. Not a curve point. */
async function pubkeyOf(secret: Hex): Promise<Hex> {
  return hex(await sha256("mock-pubkey/", unhex(secret)));
}

/**
 * Mock chunk encryption: c = random nonce (32 B), d = amount32 XOR stream(sharedSecret(pubkey, nonce)).
 * Because there is no real ECDH here, the "shared secret" is derived from the *pubkey* and the
 * nonce, and decryption re-derives it from the secret's pubkey. It is decryptable by anyone who
 * knows the pubkey, which is exactly why this must never leave mock mode.
 */
async function encryptChunk(v32: number, pubkey: Hex, nonce: Uint8Array): Promise<{ c: Hex; d: Hex }> {
  const stream = await sha256("mock-stream/", unhex(pubkey), nonce);
  const d = new Uint8Array(32);
  d.set(nonce.slice(0, 28)); // carry the nonce so the ciphertext is self-contained
  const v = new DataView(new ArrayBuffer(4));
  v.setUint32(0, v32 >>> 0);
  for (let i = 0; i < 4; i++) d[28 + i] = new Uint8Array(v.buffer)[i] ^ stream[i];
  return { c: hex(nonce), d: hex(d) };
}

async function decryptChunk(ct: { c: Hex; d: Hex }, pubkey: Hex): Promise<number> {
  const nonce = unhex(ct.c);
  const stream = await sha256("mock-stream/", unhex(pubkey), nonce);
  const d = unhex(ct.d);
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) bytes[i] = d[28 + i] ^ stream[i];
  return new DataView(bytes.buffer).getUint32(0);
}

let nonceCounter = 0;
async function freshNonce(tag: string): Promise<Uint8Array> {
  nonceCounter += 1;
  return sha256("mock-nonce/", tag, String(nonceCounter), String(Date.now()));
}

async function encryptTo(amount: bigint, pubkey: Hex, tag: string): Promise<ChunkedCiphertext> {
  const lo = Number(amount & 0xffffffffn);
  const hi = Number((amount >> 32n) & 0xffffffffn);
  return {
    lo: await encryptChunk(lo, pubkey, await freshNonce(tag + "/lo")),
    hi: await encryptChunk(hi, pubkey, await freshNonce(tag + "/hi")),
  };
}

async function sleepProgress(onProgress: ProgressFn | undefined, stages: string[], totalMs: number) {
  const per = totalMs / stages.length;
  for (let i = 0; i < stages.length; i++) {
    onProgress?.(i / stages.length, stages[i]);
    await new Promise((r) => setTimeout(r, per));
  }
  onProgress?.(1, "done");
}

export const mockBackend: CryptoBackend = {
  name: "mock (xorshift + hash, NOT SECURE)",
  isMock: true,

  async generateKeypair(): Promise<EncryptionKeypair> {
    const s = new Uint8Array(32);
    crypto.getRandomValues(s);
    const secret = hex(s);
    return { secret, pubkey: await pubkeyOf(secret) };
  },

  pubkeyOf,

  encryptAmount(amount, pubkey) {
    return encryptTo(amount, pubkey, "enc");
  },

  async decryptAmount(ct, secret) {
    const pk = await pubkeyOf(secret);
    const lo = await decryptChunk(ct.lo, pk);
    const hi = await decryptChunk(ct.hi, pk);
    return (BigInt(hi) << 32n) + BigInt(lo);
  },

  async proveTransfer(input: TransferProofInput, onProgress?: ProgressFn): Promise<TransferProofOutput> {
    if (input.amount < 0n || input.amount > input.oldBalance) throw new Error("insufficient confidential balance");
    await sleepProgress(onProgress, ["decrypting balance", "building witness", "proving (Groth16)", "encoding"], 1400);
    const senderPk = input.senderKeypair.pubkey;
    const lo = Number(input.amount & 0xffffffffn);
    const hi = Number((input.amount >> 32n) & 0xffffffffn);
    const mk = async (v: number, tag: string) => {
      const nonce = await freshNonce(tag);
      const s = await encryptChunk(v, senderPk, nonce);
      const r = await encryptChunk(v, input.receiverPubkey, nonce);
      const a = await encryptChunk(v, input.auditorPubkey, nonce);
      return { c: s.c, dSender: s.d, dReceiver: r.d, dAuditor: a.d };
    };
    const transfer: TransferCiphertext = { lo: await mk(lo, "t/lo"), hi: await mk(hi, "t/hi") };
    const newBalance = await encryptTo(input.oldBalance - input.amount, senderPk, "nb");
    const proof = hex(
      await sha256("mock-proof/transfer/", input.sender, input.receiver, String(input.nonce), transfer.lo.c, transfer.hi.c, newBalance.lo.c)
    );
    return { transfer, newBalance, proof: `0x${proof.slice(2).repeat(4)}` as Hex };
  },

  async proveWithdraw(input: WithdrawProofInput, onProgress?: ProgressFn): Promise<WithdrawProofOutput> {
    if (input.amount < 0n || input.amount > input.oldBalance) throw new Error("insufficient confidential balance");
    await sleepProgress(onProgress, ["decrypting balance", "building witness", "proving (Groth16)", "encoding"], 1200);
    const newBalance = await encryptTo(input.oldBalance - input.amount, input.keypair.pubkey, "nb");
    const proof = hex(await sha256("mock-proof/withdraw/", input.owner, String(input.nonce), String(input.amount), newBalance.lo.c));
    return { newBalance, proof: `0x${proof.slice(2).repeat(4)}` as Hex };
  },
};
