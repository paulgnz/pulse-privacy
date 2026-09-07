# xpr-conf-tsc — confidential token for XPR Network testnet (proton-tsc)

Testnet build of the design in [`docs/01-design.md`](../../docs/01-design.md) §11. Written in
AssemblyScript with `proton-tsc`, because XPR testnet (Leap v5.0.3) already has the
`CRYPTO_PRIMITIVES` host functions and `proton-tsc` wraps them (`bn128Add/Mul/Pair`).

## Status

| milestone | state |
|---|---|
| **T1 Groth16 verifier on testnet** | ✅ `assembly/groth16.contract.ts` deployed to **`xprconf`** (testnet); an arkworks proof verifies on chain, tampered inputs/proofs are rejected. Local vert tests pass. |
| T2 transfer circuit + ceremony rehearsal | — |
| T3 confidential token contract | — |
| T4 dapp | — |
| T5 auditor CLI | — |

Testnet account: `xprconf` (created 2026-09-07, funded by `paul123`, 200 KB RAM, key in the
proton CLI keychain on Paul's Mac). Explorer: <https://testnet.explorer.xprnetwork.org/account/xprconf>

## Layout

```
assembly/groth16.contract.ts   T1: `verify(vk, proof, inputs)` + reusable `groth16Verify()`
tests/groth16.test.mjs         vert test: valid proof accepted, tampered input/proof rejected
tests/encode-fixture.mjs       prints the action payload for `proton action`
tests/fixtures/*.json          arkworks proofs in EIP-196/197 encoding (from bench --emit-evm-fixture)
```

Encoding: big-endian 32-byte words; G1 = (x, y); G2 = (x_im, x_re, y_im, y_re). The vk is
`alpha ‖ beta ‖ gamma ‖ delta ‖ IC[0..n]`, the proof is `A ‖ B ‖ C`, inputs are `32·n` bytes.
The contract negates A and checks `e(-A,B)·e(α,β)·e(vk_x,γ)·e(C,δ) == 1` with one
`alt_bn128_pair` call and `n` `alt_bn128_mul` + `alt_bn128_add` calls.

## Commands

```sh
npm install                       # proton-tsc, @proton/vert, typescript 4.9.5 (proton-asc needs TS 4)
npm run build                     # → assembly/target/groth16.contract.{wasm,abi}
npm test                          # vert: 3 checks against tests/fixtures/groth16_2_evm.json

# regenerate the fixture from the bench crate
(cd ../../bench && cargo run --release -- --emit-evm-fixture ../contracts/xpr-conf-tsc/tests/fixtures/groth16_2_evm.json)

# testnet
proton chain:set proton-test
printf 'y\n' | proton contract:set xprconf ./assembly/target
proton action xprconf verify "$(node tests/encode-fixture.mjs)" xprconf            # valid → "groth16: valid"
proton action xprconf verify "$(node tests/encode-fixture.mjs --tamper)" xprconf   # → assertion "invalid proof"
```

Gotchas found on the way: `proton-asc` runs under ts-node and needs `typescript@4.9.5` (TS 7
breaks it); vert wires `contract.actions` asynchronously after `createContract`, so tests must
wait for it; a proof whose point is off-curve fails inside the host function
(`bn128Pair error`) rather than in the final check.
