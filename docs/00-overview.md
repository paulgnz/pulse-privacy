# 00 — Overview: what is where

Private XPR has two versions. **v2, `xprshield`**, is the product: sealed notes, receiver and
amount hidden, payer signed, committee viewing key. **v1, `xprconf`**, is the confidential
contract it replaces: amount hidden, parties visible. v1 is closed to deposits (2026-09-08) and
stays withdrawable indefinitely.

| what | v2 (product) | v1 (legacy) |
|---|---|---|
| design | [06-shielded-design.md](06-shielded-design.md) | [01-design.md](01-design.md) |
| circuit | `circuits/shielded/joinsplit.circom` (rev 4, 29,826 constraints) | `circuits/transfer/transfer.circom` |
| note / box library (Node) | `circuits/lib/notes.mjs` | `circuits/lib/elgamal.mjs` |
| contract | `contracts/xpr-shield-tsc/` (vert tests in `tests/`, testnet demo CLI incl. `audit`, `recover`) | `contracts/xpr-conf-tsc/` |
| dapp | `dapp/src/lib/shield/*`, `dapp/src/components/Shielded*.tsx`, `ShieldPages.tsx`, `ShieldWalkthrough.tsx` | `dapp/src/lib/{chain,client,keys,privacy}.ts`, `components/{Overview,Send,Deposit,Withdraw,Activity,Auditor,Settings,Onboarding,About}.tsx` |
| headless checks | `dapp/e2e/` (README there) | `dapp/e2e/live-check.mjs` |
| security reviews | [03-security-review.md](03-security-review.md), "Shielded mode" sections; briefs in [04](04-review-briefs.md) | [03](03-security-review.md) earlier sections |
| mainnet | [07-private-xpr-v2-mainnet.md](07-private-xpr-v2-mainnet.md) (not yet deployed) | [02-mainnet-runbook.md](02-mainnet-runbook.md) (deployed 2026-09-07) |
| ceremony | `ceremony/` (finalise, verify) and `ceremony-web/` (contribution site); phase 1 universal, phase 2 for the join-split circuit | phase 1 shared; v1 keeps its rehearsal key |

Shared: `dapp/src/lib/crypto/*` (Baby Jubjub, field), `dapp/src/lib/unlock.ts` (key derivation
from a wallet signature; the signed texts must never change), `dapp/src/components/ui.tsx`,
`dapp/src/config.ts` (networks, contracts, `SHIELD_HOME`, `PATHS`, `CONF_DEPOSITS_CLOSED`).

Sites: one per network. Where v2 is enabled (testnet today, mainnet after
[07](07-private-xpr-v2-mainnet.md)), v2 is at `/` and v1 at `/old`; elsewhere v1 is at `/`.

Naming: the product is **Private XPR**. "Shielded" and "confidential" survive in file and
identifier names as the mechanisms' names; user-facing text says Private XPR, v1 and v2.
