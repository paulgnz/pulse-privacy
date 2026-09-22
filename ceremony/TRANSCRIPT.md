# Ceremony transcript

## Phase 1 (powers of tau, 2^16)

Start file `p1/00-start.ptau` (no secret), seeded 2026-09-07. Fourteen contributions through the
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
| 13 | echox | 2026-09-10 21:52 |
| 14 | lintoboss | 2026-09-10 22:25 |

Last contribution: `p1/14-lintoboss-bf0544a8….ptau`, sha256
`bf0544a824e45fe0571aafdaab33a9dacac00e5a29c1fc1dbaaaea3514c0a621`. Attestations 01 to 14 are
in `contributions/`.

**Beacon announced 2026-09-10 21:45 UTC, before the block existed: XPR mainnet block
402,780,000.** Produced 2026-09-10 22:40 UTC, irreversible 22:43. Block id
`1801ef60c28f8c68a7506bf6f45dae41791753a68bb7354c4e6a9021b66a6c82`, reported identically by
api.protonnz.com, proton.eosusa.io and proton.cryptolions.io. Applied with `finalize.mjs phase1`
(snarkjs `powersoftau beacon`, 10 iterations, then `prepare phase2`).

| file | sha256 |
|---|---|
| last contribution `p1/14-lintoboss-….ptau` | `bf0544a824e45fe0571aafdaab33a9dacac00e5a29c1fc1dbaaaea3514c0a621` |
| `final/pot16_final.ptau` (also `p1/final.ptau` on the site) | `50ea427d9d9d23086dbd85b0de46bafca30efac1355fd98cc43f061715071ad6` |

Record: `final/phase1.json`. Phase 1 is closed.

Correction, same evening: the coordinator first applied the beacon at 22:44 UTC to contribution
12 (abtsec), from a copy downloaded before echox (13) and lintoboss (14) had contributed, and
opened phase 2 on that result (`p1/final-pot16.ptau` `f57eb7f4…`, `p2/00-setup.zkey`
`c77f99a0…`). The mistake was noticed at 23:05 UTC, before anyone had contributed to phase 2;
the finalisation was redone from contribution 14, phase 2 was re-opened from the new setup file,
and the superseded files were deleted from the site. Nothing about the beacon changed: the height
was announced at 21:45, both late contributions landed before the block was produced at 22:40.

## Phase 2 (join-split circuit, revision 6)

Circuit `circuits/shielded/joinsplit.circom` at commit `35341a0`, compiled with circom 2.2.2
(`circom shielded/joinsplit.circom --r1cs --wasm --sym --O2 -o build -l node_modules`), which is
deterministic: `joinsplit.r1cs` sha256
`6bb4c274bdbfecc60f49664039ec724d492992c2f5d34401122befd1e5b1f867` (recompiled and compared
2026-09-10). Opened 2026-09-10 23:10 UTC from `contributions/00-setup.zkey` = `p2/00-start.zkey`
(snarkjs `groth16 setup` over the phase-1 final; no secret), sha256
`319ff7963b6c8a46e527a101225e93cf2d3181232cc3cb8129f4b7b51ce0419b`; record
`contributions/00-setup.zkey.json`. Sixteen contributions, the first an offline command-line
contribution by paul (2026-09-10 23:15 UTC), the last by daorach (2026-09-14 10:46 UTC).

**Beacon announced 2026-09-22 ~17:05 UTC, before the block existed: XPR mainnet block
404,820,000** (announcement: https://x.com/paulgrey/status/2102446574655918121) (expected about 18:02 UTC). The site was closed at 17:57:44 UTC (block 404,819,429).
Block 404,820,000 was produced 2026-09-22 18:02:26 UTC; id
`1821102043702b0380a2a3bfd57e239dd5a7d417f8a739ea06e8a424c342a20f`, reported identically by
api.protonnz.com and proton.cryptolions.io (proton.eosusa.io did not answer). The last
contribution, #16 daorach, was recorded 2026-09-14 10:46 UTC, before the block. Applied with
`finalize.mjs phase2` (snarkjs `zkey beacon`, 10 iterations).

| file | sha256 |
|---|---|
| last contribution `p2/16-daorach-….zkey` | `6ab8879c2caf87f5645fb7c2d9f57b37d39511a63ba91f1c3eeb62b03e667c25` |
| `final/joinsplit_final.zkey` | `26ec798e00175fda8768b5956d7cc77f589138182b326e776704639cabdd7a0f` |
| `final/joinsplit_vk.json` | `9f9e5db5487e0bb4f08cdc76372826169f18e1354bf0c6cb33e16c6f51b23766` |
| `final/vk.hex` (for `init` / `setvk`) | `bc498abd08417af55d60326af11431e29a1a9cb3d79ed38e48ab4c5bf8a83978` |

`snarkjs zkey verify joinsplit.r1cs pot16_final.ptau joinsplit_final.zkey`: **ZKey Ok**, listing
contributions 1 (paul, offline) to 16 (daorach) and 17 (the beacon). Record: `final/phase2.json`,
attestations `contributions/p2-NN-<account>.json`. **The ceremony is complete.**
