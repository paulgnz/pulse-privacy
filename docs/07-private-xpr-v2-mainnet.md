# 07 — Private XPR v2 mainnet runbook (account `privatexpr`)

Status 2026-09-08: testnet complete and in use; mainnet not yet deployed. This is the checklist,
in order. Nothing here is done until its line says so.

## 0. Decisions already made

- Product name: **Private XPR**. Version 1 is the confidential contract `xprconf` (amount hidden);
  version 2 is the shielded contract, `xprshield` on testnet and **`privatexpr` on mainnet** (receiver and
  amount hidden). v2 replaces v1 (docs/06 §8.5).
- v1 deposits closed on both networks on 2026-09-08 by `setlimits` with both caps at one unit
  (mainnet tx: see §6). Withdrawals and payments inside continue. `pause` is **not** used: on v1 it
  also blocks withdrawals and exists only for the committee's `restore`.
- One site per network; v2 is the site, v1 at `/old` withdraw-only. Testnet done; mainnet flips
  in §5.

## 1. Before deployment

| item | who | status |
|---|---|---|
| Phase 1 of the ceremony: ≥ 5 contributors, then finalise with an announced beacon block | Paul, contributors | 3 of 5 |
| Phase 2 for `circuits/shielded/joinsplit.circom` **revision 5** (31,659 constraints) on the ceremony site, then finalise; `final/vk.hex` | Paul | not started |
| Contract account **`privatexpr`** on mainnet (decided 2026-09-08; explorer.xprnetwork.org/account/privatexpr): created; owner moves to `admin.proton@committee` on launch day (§2a) | Paul | created |
| Deploy permission: v1 was deployed from the operational key without asking anyone, so none needed; if `setcode` is ever refused, that is the moment to ask | Paul | none needed |
| RAM: code ≈ 82 KB WASM → ≈ 250 KB; tables: 20-level tree frontier + 1,024-root ring ≈ 70 KB; each note ≈ 300 B (paid by the depositor/spender); keys ≈ 200 B per account (paid by the owner). Buy 800 KB to start | Paul | not bought |
| Resource plan for the account (NET for the code upload, CPU for nothing: users pay their own) via `resources::buyplan` | Paul | not bought |
| Auditor key: reuse v1's mainnet viewing key (the file Paul holds) or generate a fresh pair the same way; only the public key goes on chain (`init`) and gets pinned in `dapp/src/config.ts` | Paul | decide |
| External audit, if wanted (scope: `circuits/shielded/joinsplit.circom`, `contracts/xpr-shield-tsc/assembly/*.ts`, `dapp/src/lib/shield/*`); three internal rounds and three Codex passes are in docs/03 | Paul | optional |
| Launch caps: XPR pool 1,000,000 / deposit 10,000 / min 1; XMD pool 100,000 / deposit 100 / min 1 (same as v1's first caps) | product | proposed |
| Domain: register `privatexpr.com` (free on 2026-09-08; take `.io` too). Switch at launch, not before: passkey users' saved keys are per origin, and v2 has no mainnet users yet. Layout: `privatexpr.com` v2 at `/`, v1 at `/old`; `testnet.privatexpr.com`; `ceremony.privatexpr.com` alongside the current ceremony address; `private.protonnz.com` and its testnet become permanent redirects with the path kept. Code: `SITES` in `dapp/src/config.ts`, Open Graph URLs in `dapp/index.html`, ceremony-web links, README, docs | Paul | not registered |

## 2. Build the mainnet contract

```sh
cd contracts/xpr-shield-tsc
npm run build:mainnet          # compiles with TESTNET=false: `reset` refuses ("not available in this build"); writes deploy/mainnet/
shasum -a 256 deploy/mainnet/xprshield.contract.wasm
```

The hash goes in this file and in the announcement, so anyone can compare it with `get_code_hash`.

Built 2026-09-08 (night) from circuit revision 5 and the merged outputs table (see docs/03 "Privacy and resource pass"): wasm `30e13a759640952da071ce90db3a927cbbfec4f060a3012051ee6f85cbd745fd`, abi `a1dfe5efdfc527f499d62febd7adfbeca418d625a15411f7dbc780cd97656bd8`. Testnet runs the same source with TESTNET=true, code hash `91768790…`, initialised with the revision-5 rehearsal key. Rebuild and re-hash after any contract change.

## 2a. Secure the account (launch day, after the final contract is deployed and verified; Paul's call, not before)

```sh
proton chain:set proton
proton action eosio updateauth '{"account":"privatexpr","permission":"owner","parent":"","auth":{"threshold":1,"keys":[],"accounts":[{"permission":{"actor":"admin.proton","permission":"committee"},"weight":1}],"waits":[]}}' privatexpr@owner
```

After this only the committee (3 of 6) can change the account's keys; the operational key keeps `active` for deployment and setup (uploads use `active`, so the owner move alone would not block them), and `active` moves to the committee after launch as with v1. Decision 2026-09-08: owner stays on the operational key until the code is final, so contracts can be re-uploaded freely.

## 3. Deploy (day of)

```sh
proton chain:set proton
proton contract:set privatexpr ./deploy/mainnet          # answer y to the table-change prompt if any
proton action privatexpr init '{"auditor_pubkey":"<64 bytes hex>","vk":"<final/vk.hex>"}' privatexpr@active
proton action privatexpr addtoken '{"sym":"4,XPR","token_contract":"eosio.token","token_id":1,"max_pool":"10000000000","max_deposit":"100000000","min_deposit":"10000"}' privatexpr@active
proton action privatexpr addtoken '{"sym":"6,XMD","token_contract":"xmd.token","token_id":2,"max_pool":"100000000000","max_deposit":"100000000","min_deposit":"1000000"}' privatexpr@active
# verify: get_code_hash == §2; config.vk sha256 == ceremony final/phase2.json vkHex; tokens rows present
```

Then move `privatexpr@active` to the committee (or an msig) as with v1.

## 4. Dapp

- `dapp/src/config.ts`: mainnet block `SHIELD = { enabled: true, contract: "privatexpr" }` (testnet stays `xprshield`); the
  circuit files under `public/circuit/` must be the ceremony's final zkey (`joinsplit-r4_final.zkey`
  replaced by the ceremony output; keep the revision in the name).
- `SHIELD_HOME` follows `SHIELD.enabled`, so enabling it on mainnet makes v2 the site and v1 `/old`.
- Deploy is a push to `main`; the `pulse-privacy` Vercel project builds mainnet.

## 5. After launch

- Announce: contract hash, ceremony transcript, caps, what is hidden and what is not.
- Watch the first day: `testnet-demo.mjs audit` equivalent for mainnet (auditor CLI) with the
  committee key; escrow against counters on the Auditor tab.
- v1 retirement: already closed to deposits; keep withdrawals and the auditor working
  indefinitely; after a quiet period, return remaining escrow through the committee's `restore`.

## 6. Record

| date | what | tx / hash |
|---|---|---|
| 2026-09-08 | v1 deposits closed on mainnet (`setlimits` 4,XPR and 6,XMD to 1 / 1); pools at closing: 10,361.2141 XPR, 1.000000 XMD | `e12ad6f06a3c…` (XPR), `0bbf1ef1520f…` (XMD) |
| 2026-09-08 | v1 deposits closed on testnet (4,XPR and 6,XMD) | |
| 2026-09-08 | mainnet account `privatexpr` created by paul123 with 8 KB RAM; owner and active on the operational key `PUB_K1_7YyTAN9…` (the same key as xprconf's active). Next: owner → `admin.proton@committee` (see below), more RAM before deploy | explorer.xprnetwork.org/account/privatexpr |
