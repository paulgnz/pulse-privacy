# 02 — Mainnet runbook (XPR Network)

Status: **early access live (2026-09-07)** with caps, on the rehearsal proving key. The two
gates in §12 of the design doc still stand before the caps are raised: the multi-party ceremony
(`ceremony/`, then `setvk`) and an external audit. Deployed: account `xprconf` (created by
`paul123`, 350 KB RAM), code `8e4fa44f…`, `init` with the committee's auditor key
(secret held off-chain for the committee), `setlimits` pool 20,000 / deposit 1,000 XPR,
whole-XPR withdrawals. Owner of `xprconf` is `admin.proton@committee` (3-of-6) since tx `346f2250…`; active stays on the operational key until the ceremony key is installed and caps are settled, then moves to the committee too.

## 1. What ships

- Contract `contracts/xpr-conf-tsc` (proton-tsc), the same code as testnet, with the ceremony's
  verifying key installed via `setvk` and **soft-launch limits** set via `setlimits`.
- Dapp `dapp/` built with `VITE_NETWORK=mainnet` (Vercel project `pulse-privacy`,
  https://private.protonnz.com). Testnet stays at https://testnet.private.protonnz.com.
- Auditor CLI `tools/auditor-cli` pointed at the mainnet Hyperion
  (`HYPERION=https://hyperion-xpr-mainnet.protonnz.com`).

## 2. Before the ceremony (can start now)

| item | who | notes |
|---|---|---|
| Contract account | Paul / Metallicus | pick the name (a short premium name if desired); needs ≈ 300 KB RAM for the code plus ≈ 4 KB per token config and ≈ 350 B per registered account; the key that can `setcode` should be an msig once live |
| Deploy permission | Metallicus | XPR mainnet gates `setcode`; confirm the account is allowed to deploy |
| Auditor key | Metallicus compliance | generate with `circuits/lib` (`keygen`) on an offline machine; store the secret in an HSM or sealed offline; only the public key goes on chain. Rotation = `configure` with a new key; keep old keys to read history |
| Limits for launch | product decision | e.g. `max_deposit` 10,000 XPR, `max_pool` 1,000,000 XPR, `withdraw_granularity` whole XPR. Raise later with `setlimits` / `configure` |
| Contributors | Paul | ≥ 5 per ceremony phase; announce beacon block heights in advance |
| Audit | Metallicus | scope: `circuits/transfer/transfer.circom`, `contracts/xpr-conf-tsc/assembly/*.ts`, `circuits/lib/elgamal.mjs`, `dapp/src/lib/crypto/*` |
| Dapp config | Paul | `dapp/src/config.ts` mainnet block: contract name; Hyperion list already has protonnz first |
| Domains | Paul | `testnet.private.protonnz.com` DNS (CNAME + `_vercel` TXT); main domain flips by setting `VITE_NETWORK=mainnet` on the `pulse-privacy` project |

## 3. Ceremony

Browser-based contribution site: https://ceremony.private.protonnz.com (Vercel project
`pulse-privacy-ceremony`, root `ceremony-web/`, Blob store `pulse-privacy-ceremony`; custom domain
`ceremony.private.protonnz.com` pending DNS). Contributors connect WebAuth, take a 20-minute turn,
mix randomness in a web worker, and sign an attestation with the never-broadcast `viewkey` note
`ceremony/<phase>/<index>/<sha256>`. Phase-2 start and finalisation stay in `ceremony/`.
Testers need ≈ 1 KB of free RAM per token registration (the row is ≈ 350 B plus overhead).

Run `ceremony/README.md` end to end. Outputs: `final/transfer_final.zkey` (copy to
`dapp/public/circuit/transfer_final.zkey`), `final/transfer_vk.json`, `final/vk.hex`. Publish the
transcript. `node ceremony/verify.mjs` must pass from a clean checkout.

## 4. Deployment order (day of)

```sh
proton chain:set proton
proton ram:buy <payer> <contract> 350000
printf 'y\n' | proton contract:set <contract> ./contracts/xpr-conf-tsc/deploy/target
# verify the code hash matches the audited build
proton action <contract> init '{"sym":"4,XPR","token_contract":"eosio.token","auditor_pubkey":"<64-byte hex>","vk":"<final/vk.hex>","withdraw_granularity":"10000","deposit_granularity":"0"}' <contract>
proton action <contract> setlimits '{"sym":"4,XPR","max_pool":"10000000000","max_deposit":"100000000"}' <contract>
# confirm on chain: config.vk sha256 == ceremony final/phase2.json → vkHex; limits row present
```

Then: set `VITE_NETWORK=mainnet` on the Vercel project, redeploy, and run one register →
deposit → send → withdraw with small amounts from two accounts, and `auditor.mjs reconcile`
against mainnet, before announcing.

## 4a. Tokens

| token | symbol | contract | withdraw granularity | caps (pool / per deposit) | mainnet init tx |
|---|---|---|---|---|---|
| XPR | 4,XPR | eosio.token | 1 XPR | 100,000,000 / 1,000,000 XPR (set 2026-09-07, tx a26aea8a…) | d320e3db… |
| XMD (Metal Dollar) | 6,XMD | xmd.token | 1 XMD | 100,000 / 10,000 XMD (set 2026-09-07, tx 692b5c96…) | d53cbbfd… |

Adding a token = one `init` (same vk, same auditor key) + one `setlimits`. The circuit is
token-agnostic; amounts are 64-bit units. Testnet has both tokens too.

## 4b. Measured on mainnet (Leap v3.1.2, 2026-09-07)

| action | CPU |
|---|---:|
| register | 0.24–0.40 ms |
| deposit | 1.1–1.6 ms |
| fold | 0.45–0.6 ms |
| proven send | **12.0 ms** (testnet Leap 5: 7.8 ms) |

API nodes reject transactions over their `max-transaction-time` (30 ms by default). One tester hit
30,171 µs on a loaded node. Mitigation in the dapp: sign once, broadcast through a list of nodes,
retry on "executing for too long". Longer term: fewer public inputs / native point adds.

## 4c. Recovery and restore (code `dc7ab97d…`, 2026-09-07)

Two paths exist for a user who cannot open their boxes.

**Recovery copy.** Accounts that sign in with a passkey get a saved key. At registration (or later
from Settings) the app stores a 96-byte copy of that key on chain, encrypted to the auditor's
viewing key (`setrecovery`; ECIES on Baby Jubjub: R = r·P_a, secret XOR sha256(r·H)). To return it:

```sh
# the owner proves control of the account (a signed message naming the request), then
AUDITOR_KEYFILE=~/.pulse-privacy/mainnet-auditor.json RPC=https://api.protonnz.com \
  node tools/auditor-cli/auditor.mjs recover <account>
# hand the printed secret to the owner over a channel you trust; they import it in Settings
```

**Restore.** If a key is beyond recovery, the committee returns the balance from escrow:

1. `configure` the token with `paused = true`.
2. `node tools/auditor-cli/auditor.mjs reconcile` (and `account <name>`) to reconstruct the
   account's balance from the auditor ledger; publish the reconciliation.
3. `proton action xprconf restore '{"owner":"<name>","quantity":"<amount> XPR","memo":"<reconciliation ref>"}' xprconf`
   (contract authority; the committee once the active key moves). The account's boxes are reset,
   the pool counter reduced, and the transfer is public with the memo.
4. `configure` back to `paused = false`.

`restore` refuses to run while the token is not paused, so it can never be used quietly.

## 5. After launch

- Watch `auditor.mjs reconcile` daily; escrow must equal deposits − withdrawals.
- Raise limits stepwise (`setlimits`), never remove the granularity.
- Keep `contract:set` behind msig; any redeploy must keep table layouts (add tables, never change
  them; see the `limits` table for the pattern).
- Roll the auditor key on a schedule; the old key stays needed for old transfers.

## 6. Not in this runbook (needs decisions)

PulseVM port (`pulse-cdt-rust`, native intrinsics), the in-wallet key derivation (WebAuth
change), hidden counterparties (Phase 3).
