// The crypto seam. T2 (circuit + prover) and the real twisted-ElGamal implementation replace
// `mock.ts` with an implementation of `CryptoBackend`; nothing in the UI changes.
//
// Conventions: amounts are integer units (4 decimals) as bigint; keys and ciphertexts are
// 0x-prefixed lowercase hex. A "Ciphertext" is one twisted-ElGamal chunk pair as the contract
// stores it; a balance is two chunks (lo, hi) per docs/01-design.md §2.3.

export type Hex = `0x${string}`;

export interface EncryptionKeypair {
  /** secret scalar s (Baby Jubjub scalar field). Never leaves the device. */
  secret: Hex;
  /** P = s⁻¹·H, registered on chain. */
  pubkey: Hex;
}

/** (C, D) for one 32-bit chunk. */
export interface Ciphertext {
  c: Hex;
  d: Hex;
}

/** A balance or transfer amount: two chunks. */
export interface ChunkedCiphertext {
  lo: Ciphertext;
  hi: Ciphertext;
}

/** The transfer ciphertext: one commitment per chunk, one handle per reader. */
export interface TransferCiphertext {
  lo: { c: Hex; dSender: Hex; dReceiver: Hex; dAuditor: Hex };
  hi: { c: Hex; dSender: Hex; dReceiver: Hex; dAuditor: Hex };
}

export interface TransferProofInput {
  sender: string;
  receiver: string;
  nonce: bigint;
  amount: bigint;
  oldBalance: bigint;
  oldBalanceCiphertext: ChunkedCiphertext;
  senderKeypair: EncryptionKeypair;
  receiverPubkey: Hex;
  auditorPubkey: Hex;
}

export interface TransferProofOutput {
  transfer: TransferCiphertext;
  newBalance: ChunkedCiphertext;
  /** 128-byte Groth16 proof, EIP-196/197 encoding (A ‖ B ‖ C = 256 B uncompressed). */
  proof: Hex;
}

export interface WithdrawProofInput {
  owner: string;
  nonce: bigint;
  amount: bigint;
  oldBalance: bigint;
  oldBalanceCiphertext: ChunkedCiphertext;
  keypair: EncryptionKeypair;
  /** the pool's auditor key (the withdraw statement still carries an auditor handle) */
  auditorPubkey: Hex;
}

export interface WithdrawProofOutput {
  newBalance: ChunkedCiphertext;
  proof: Hex;
}

export type ProgressFn = (fraction: number, stage: string) => void;

export interface CryptoBackend {
  readonly name: string;
  readonly isMock: boolean;
  generateKeypair(): Promise<EncryptionKeypair>;
  /** Public key for a secret (used on import). */
  pubkeyOf(secret: Hex): Promise<Hex>;
  /** Encrypt an amount to a single reader (used for deposits in mock mode and for tests). */
  encryptAmount(amount: bigint, pubkey: Hex): Promise<ChunkedCiphertext>;
  /** Decrypt a balance/transfer chunk pair addressed to `secret`'s key. */
  decryptAmount(ct: ChunkedCiphertext, secret: Hex): Promise<bigint>;
  proveTransfer(input: TransferProofInput, onProgress?: ProgressFn): Promise<TransferProofOutput>;
  proveWithdraw(input: WithdrawProofInput, onProgress?: ProgressFn): Promise<WithdrawProofOutput>;
}
