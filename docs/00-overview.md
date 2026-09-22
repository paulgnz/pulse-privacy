# 00 — Overview: what is where

Private XPR has two versions. **v2** is the product (mainnet `privatexpr`, live since 2026-09-22; testnet `xprshield`): sealed notes, receiver and
amount hidden, payer signed, committee viewing key. **v1, `xprconf`**, is the confidential
contract it replaces: amount hidden, parties visible. v1 is closed to deposits (2026-09-08) and
stays withdrawable indefinitely.

| what | v2 (product) | v1 (legacy) |
|---|---|---|
| design | [06-shielded-design.md](06-shielded-design.md) | [01-design.md](01-design.md) |
| circuit | `circuits/shielded/joinsplit.circom` (rev 6, 31,708 constraints; ceremony key `joinsplit-r6c`) | `circuits/transfer/transfer.circom` |
| note / box library (Node) | `circuits/lib/notes.mjs` | `circuits/lib/elgamal.mjs` |
| contract | `contracts/xpr-shield-tsc/` (vert tests in `tests/`, testnet demo CLI incl. `audit`, `recover`) | `contracts/xpr-conf-tsc/` |
| dapp | `dapp/src/lib/shield/*`, `dapp/src/components/Shielded*.tsx`, `ShieldPages.tsx`, `ShieldWalkthrough.tsx` | `dapp/src/lib/{chain,client,keys,privacy}.ts`, `components/{Overview,Send,Deposit,Withdraw,Activity,Auditor,Settings,Onboarding,About}.tsx` |
| headless checks | `dapp/e2e/` (README there) | `dapp/e2e/live-check.mjs` |
| headless client | `client/` (`node client/privatexpr.mjs`): keys, register, deposit, balance, send, withdraw, activity, backups, restore, and the committee's audit and recover; same two-node checks as the app; signs through the proton CLI keychain | none |
| security reviews | [03-security-review.md](03-security-review.md), "Shielded mode" sections; briefs in [04](04-review-briefs.md) | [03](03-security-review.md) earlier sections |
| mainnet | [07-private-xpr-v2-mainnet.md](07-private-xpr-v2-mainnet.md) (deployed and launched 2026-09-22) | [02-mainnet-runbook.md](02-mainnet-runbook.md) (deployed 2026-09-07) |
| ceremony | `ceremony/` (finalise, verify) and `ceremony-web/` (contribution site); complete 2026-09-22 (phase 1: 14 contributors, phase 2: 16), record in `ceremony/TRANSCRIPT.md` | phase 1 shared; v1 keeps its rehearsal key |

Shared: `dapp/src/lib/crypto/*` (Baby Jubjub, field), `dapp/src/lib/unlock.ts` (key derivation
from a wallet signature; the signed texts must never change; the v2 text differs per network), `dapp/src/components/ui.tsx`,
`dapp/src/config.ts` (networks, contracts, `SHIELD_HOME`, `PATHS`, `CONF_DEPOSITS_CLOSED`).

Sites: www.privatexpr.com (mainnet) and testnet.privatexpr.com; v2 at `/`, v1 at `/old`. The old
private.protonnz.com names still serve the same sites until v1 has drained.

Naming: the product is **Private XPR**. "Shielded" and "confidential" survive in file and
identifier names as the mechanisms' names; user-facing text says Private XPR, v1 and v2.
