# Ceremony transcript

## Phase 1 (powers of tau, 2^16)

Start file `p1/00-start.ptau` (no secret), seeded 2026-09-07. Twelve contributions through the
site, each signed by the contributor's XPR account; the full list with hashes is in
`/api/state` on ceremony.privatexpr.com and will be copied here with the attestation files once
the phase is finalised.

| # | account | when (UTC) |
|---|---|---|
| 1 | paul | 2026-09-07 09:24 |
| 2 | xtantin | 2026-09-07 09:46 |
| 3 | perseus.gm | 2026-09-07 12:17 |
| 4 | drowninshark | 2026-09-08 23:12 |
| 5 | cryptqueenie | 2026-09-08 23:15 |
| 6 | justinlottt | 2026-09-09 00:35 |
| 7 | onthewall | 2026-09-09 05:31 |
| 8 | daorach | 2026-09-09 08:24 |
| 9 | wesleyl | 2026-09-09 08:55 |
| 10 | kwco | 2026-09-09 15:25 |
| 11 | kylenelson | 2026-09-10 10:43 |
| 12 | abtsec | 2026-09-10 18:21 |

Last contribution: `p1/12-abtsec-28898f8a….ptau`, sha256
`28898f8aaa2f5add5c9c17a552e102d026fc0a42fcec2ea73ec4b00a65577f2f`.

**Beacon announced 2026-09-10 21:45 UTC, before the block existed: XPR mainnet block
402,780,000** (expected about 22:40 UTC). Its block id, as reported by at least two independent
RPC nodes, is applied to the last contribution to make `final/pot16_final.ptau`; the id and the
hashes are recorded in `final/phase1.json` once done.

## Phase 2 (join-split circuit, revision 6)

Circuit `circuits/shielded/joinsplit.circom` at commit `35341a0`, compiled with circom 2.2.2
(`circom shielded/joinsplit.circom --r1cs --wasm --sym --O2 -o build -l node_modules`), which is
deterministic: `joinsplit.r1cs` sha256
`6bb4c274bdbfecc60f49664039ec724d492992c2f5d34401122befd1e5b1f867` (recompiled and compared
2026-09-10). Not started yet.
