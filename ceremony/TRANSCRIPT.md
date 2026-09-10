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
`contributions/00-setup.zkey.json`. Contributions are being collected on the site.
