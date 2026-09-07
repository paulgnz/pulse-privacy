# dapp — Confidential XPR (testnet front end, T4 + T4b)

The wallet-side of [`docs/01-design.md`](../docs/01-design.md) as a web dapp that needs **no
WebAuth changes**: WebAuth signs ordinary actions; the dapp holds the encryption key, runs the
prover, and decrypts. Register · deposit · send · receive/fold · withdraw · activity ·
settings (key export/import) · auditor mode.

Vite + React 19 + TypeScript. Login through `@proton/web-sdk` 4 + `@proton/link` 4 against
**XPR testnet** (contract `xprconf`). The public XPR balance is read live from `eosio.token`.

## Real mode (default)

The crypto is real and the contract is live. `src/lib/crypto/real.ts` implements twisted
ElGamal on Baby Jubjub in plain `bigint` (`babyjub.ts`, no circomlibjs in the browser) and
proves with **snarkjs** in the browser using the circuit artifacts in `public/circuit/`
(`transfer.wasm` 288 KB, `transfer_final.zkey` 25 MB, both from `circuits/build`). Formats
are byte-identical to `circuits/lib/elgamal.mjs` and the `xprconf` contract; `scripts/crosscheck.mjs`
proves it against the reference library, including a full proof.

What is read from where:

| data | source |
|---|---|
| your confidential row (pubkey, avail, pending, nonce) | `xprconf` table `accounts`, scope `1380997124` ("4,XPR") |
| auditor pubkey, granularities, paused | `xprconf` table `config` |
| peers you can pay | every row of `accounts` |
| activity, incoming transfers, pool edges, auditor ledger | Hyperion `https://test.proton.eosusa.io/v2/history/get_actions?account=xprconf` (the only testnet indexer at head) |
| public balance, escrow | `eosio.token` via RPC |

Send / withdraw fold pending credit in the same transaction (`[applypending, send]`), with the
folded ciphertext computed locally by homomorphic addition so the proof matches what the
contract stores. Old-balance chunks may be un-normalised after folds; decryption tries 32,
then 36 and 40 bits.

Timings in headless Chrome (M4, `scripts/smoke.mjs`): BSGS table + first decrypt ≈ 270 ms
once per session, later decrypts ≈ 20 ms, a transfer proof ≈ 1.6 s. `vercel.json` caches
`/circuit/*` for a year (rename the files when the circuit changes).

## Mock mode

`VITE_CRYPTO=mock npm run dev`: a banner says **MOCK MODE**. The backend is a keyed hash
stream, "proofs" are hashes, and the contract is a simulated pool in `localStorage` (peers
alice…erin, escrow, auditor key, edge counter). Useful for UI work without proving.

## Mainnet caveat

Nothing here is mainnet-ready: the zkey comes from a one-contributor rehearsal ceremony, the
contract has no proof-of-knowledge on `register`, and the encryption key lives in
`localStorage`. See `docs/01-design.md` §2.8, §11.

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

## Commands

```sh
npm install
npm run dev                      # http://localhost:5175 (real mode)
VITE_CRYPTO=mock npm run dev     # simulated pool
npm run build                    # tsc + vite → dist/
node scripts/crosscheck.mjs      # format compatibility with circuits/lib + a real proof (needs circuits/build)
PROVE=1 node scripts/smoke.mjs   # headless Chrome: loads the app, runs keygen/decrypt/proof in-page
```

Deploy: `vercel --prod` from `dapp/` (static Vite output; `vercel.json` carries the headers).

## Hosting

Two Vercel projects build the same repo (root `dapp`), selected by `VITE_NETWORK`:

| project | network | domain |
|---|---|---|
| `pulse-privacy` | testnet today; switch `VITE_NETWORK=mainnet` at launch | https://private.protonnz.com |
| `pulse-privacy-testnet` | testnet | https://testnet.private.protonnz.com |

Mainnet config (chain id, endpoints, Hyperion list with `hyperion-xpr-mainnet.protonnz.com` first)
is in `src/config.ts`; the mainnet contract account does not exist yet and mainnet is gated on
the real ceremony (docs §12). Hyperion reads fail over across the list.

Vercel project `pulse-privacy` (team paulgnzs-projects), production alias
<https://private.protonnz.com>. Deploy with `vercel --prod` from `dapp/` (the directory is
linked; `.vercel/` is gitignored). `vercel.json` sets an immutable
cache on `/circuit/*`, and the SPA rewrite.

**Custom domain `private.protonnz.com`:** `protonnz.com` is not in this Vercel account
(`vercel domains add` returns 403) and its DNS is on Cloudflare. Two options:
1. In Vercel, add `protonnz.com` to the account/team that owns it and then
   `vercel domains add private.protonnz.com pulse-privacy`; or
2. In Cloudflare DNS: `CNAME private → cname.vercel-dns.com` (DNS only, not proxied), plus the
   `TXT _vercel` verification record Vercel prints when the domain is added to the project.

Do not add `Cross-Origin-Opener-Policy: same-origin` (or COEP) to this site: the WebAuth web
wallet opens webauth.com in a popup and answers through `window.opener.postMessage`, which that
policy severs, so login never completes. snarkjs proves single-threaded here (≈ 1.6 s).
