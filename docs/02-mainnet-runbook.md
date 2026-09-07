# 02 — Mainnet runbook (XPR Network)

Status: **early access live (2026-09-07)** with caps, on the rehearsal proving key. The two
gates in §12 of the design doc still stand before the caps are raised: the multi-party ceremony
(`ceremony/`, then `setvk`) and an external audit. Deployed: account `xprconf` (created by
`paul123`, 350 KB RAM), code `8e4fa44f…`, `init` with the committee's auditor key
(secret held off-chain by Paul for the committee), `setlimits` pool 20,000 / deposit 1,000 XPR,
whole-XPR withdrawals. Governance transfer to `admin.proton@committee` pending decision.

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

## 5. After launch

- Watch `auditor.mjs reconcile` daily; escrow must equal deposits − withdrawals.
- Raise limits stepwise (`setlimits`), never remove the granularity.
- Keep `contract:set` behind msig; any redeploy must keep table layouts (add tables, never change
  them; see the `limits` table for the pattern).
- Roll the auditor key on a schedule; the old key stays needed for old transfers.

## 6. Not in this runbook (needs decisions)

PulseVM port (`pulse-cdt-rust`, native intrinsics), the in-wallet key derivation (WebAuth
change), hidden counterparties (Phase 3).
