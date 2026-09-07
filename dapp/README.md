# dapp — Confidential XPR (testnet front end, milestone T4)

The wallet-side of [`docs/01-design.md`](../docs/01-design.md) as a web dapp that needs **no
WebAuth changes**: WebAuth signs ordinary actions; the dapp holds the encryption key, runs the
prover, and decrypts. Register · deposit · send · receive/fold · withdraw · activity ·
settings (key export/import) · auditor mode.

Vite + React 19 + TypeScript. Login through `@proton/web-sdk` 4 + `@proton/link` 4 against
**XPR testnet** (contract `xprconf`). The public XPR balance is read live from `eosio.token`.

## Mock mode (default)

`VITE_CRYPTO` is unset or `mock`: a banner says **MOCK MODE**. The crypto backend
(`src/lib/crypto/mock.ts`) is a keyed hash stream, not ElGamal, and "proofs" are hashes; the
"contract" is a simulated pool in `localStorage` with five registered peers (alice…erin, 5,000
XPR each), an escrow total, an auditor key, and a pool-edge counter. Only two things are real in
mock mode: the WebAuth session and the public XPR balance. Activity rows are marked `(mock)`.

Use **Settings → Mock controls** to simulate an incoming payment of a specific amount, then try
to withdraw exactly that amount to see the §1.9 edge warning; add pool edges to watch the
indicator move.

## Where the real pieces plug in

Nothing in the UI changes. Two seams:

1. **Crypto (T2)** — implement `CryptoBackend` from `src/lib/crypto/types.ts` and return it from
   `selectBackend()` in `src/lib/crypto/index.ts` for `VITE_CRYPTO=real`:

   ```ts
   generateKeypair(): Promise<EncryptionKeypair>
   pubkeyOf(secret: Hex): Promise<Hex>
   encryptAmount(amount: bigint, pubkey: Hex): Promise<ChunkedCiphertext>
   decryptAmount(ct: ChunkedCiphertext, secret: Hex): Promise<bigint>
   proveTransfer(input: TransferProofInput, onProgress?: ProgressFn): Promise<TransferProofOutput>
   proveWithdraw(input: WithdrawProofInput, onProgress?: ProgressFn): Promise<WithdrawProofOutput>
   ```

   Amounts are `bigint` units (4 decimals) split into two 32-bit chunks; keys and ciphertexts
   are `0x` hex; `proof` is the 256-byte uncompressed Groth16 proof in EIP-196/197 encoding,
   exactly what the T1 verifier on `xprconf` already accepts.

2. **Contract (T3)** — `src/lib/chain.ts` already builds the §4.2 actions (`register`,
   deposit as `eosio.token::transfer` with memo `conf:<owner>`, `applypending`, `transfer`,
   `withdraw`) and reads the `accounts` table; `ConfidentialClient` (`src/lib/client.ts`) uses
   them when `!backend.isMock`. Remaining T4b items once T3 is live: read the auditor pubkey and
   granularities from the `config` table, rebuild activity/incoming from Hyperion history, and
   auditor mode against real history (T5).

## Edge-privacy rules implemented (§1.9)

`src/lib/privacy.ts`: withdraw granularity (from the pool config; the UI refuses what the
contract would reject), the edge-matching warning (exact match to a recent incoming amount, or
to a sum of up to three of them; suggests a round amount and a delay; needs an explicit tick,
never a hard block), the "pool edges since your last incoming transfer" indicator, deposit
round-amount nudges, and no memo field on confidential sends.

## Key custody

The encryption secret is generated in the browser, stored under
`pulse-privacy/enckey/v1/<account>` in `localStorage`, exportable as a JSON file or to the
clipboard, importable from hex. It is never sent anywhere. The Settings page says plainly that
losing it means losing the ability to read and spend the confidential balance.

## Commands

```sh
npm install
npm run dev          # http://localhost:5175
npm run build        # tsc --noEmit && vite build → dist/
npm run typecheck
VITE_CRYPTO=real npm run dev   # throws until the T2 backend exists
```
