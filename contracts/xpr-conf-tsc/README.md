# xpr-conf-tsc — confidential token for XPR Network testnet (proton-tsc)

Testnet build of the design in [`docs/01-design.md`](../../docs/01-design.md) §11. Written in
AssemblyScript with `proton-tsc`, because XPR testnet (Leap v5.0.3) already has the
`CRYPTO_PRIMITIVES` host functions and `proton-tsc` wraps them (`bn128Add/Mul/Pair`).

## Status

| milestone | state |
|---|---|
| **T1 Groth16 verifier on testnet** | ✅ `assembly/groth16.contract.ts` deployed to **`xprconf`** (testnet); an arkworks proof verifies on chain, tampered inputs/proofs are rejected. Local vert tests pass. |
| T2 transfer circuit + ceremony rehearsal | ✅ `circuits/` (46,874 constraints, 41 public inputs, ≈ 1.6 s prove) |
| **T3 confidential token contract** | ✅ `assembly/xprconf.contract.ts` **live on testnet `xprconf`** (code `34ef52d1…`): init/register/deposit/fold/send/withdraw all exercised with real proofs; CPU: deposit 1.1 ms, fold 0.35 ms, send 7.8 ms, withdraw 7.9 ms. vert end-to-end test `tests/xprconf.test.mjs`. |
| T4 dapp | shell ✅ (`dapp/`), real crypto wiring pending |
| T5 auditor CLI | — |

Testnet account: `xprconf` (created 2026-09-07, funded by `paul123`, 200 KB RAM, key in the
proton CLI keychain on Paul's Mac). Explorer: <https://testnet.explorer.xprnetwork.org/account/xprconf>

## Layout

```
assembly/xprconf.contract.ts   T3: the confidential token (config/accounts tables; init, configure,
                               setvk, register, applypending, send, withdraw; deposit via notify;
                               viewkey/unlock: never-broadcast actions the wallet signs so the dapp
                               can derive the viewing key; Ricardian text added to the ABI post-build)
assembly/groth16.ts            Groth16 verifier over bn128Add/Mul/Pair (shared)
assembly/groth16.contract.ts   T1: standalone `verify(vk, proof, inputs)` action
assembly/babyjub.ts            Baby Jubjub adds / on-curve / v·G in-contract via `mod_exp`
assembly/consts.ts             GENERATED (circuits/scripts/gen-contract-consts.mjs): p, a, d, 2^i·G
assembly/bjdbg.contract.ts     dev-only arithmetic probe (tests/bjdbg.mjs compares with JS)
tests/groth16.test.mjs         vert: T1 verifier
tests/xprconf.test.mjs         vert: T3 end to end with real proofs (needs circuits/build)
tests/testnet-demo.mjs         the same flow on live testnet, signing via the proton CLI keychain
tests/encode-fixture.mjs       prints a T1 payload for `proton action`
```

Testnet roles: alice = `paul123`, bob = `testclient1` (both have keys in the CLI keychain);
encryption secrets in `tests/.testnet-keys.json` (gitignored, testnet only). Contract account
`xprconf` needs ≈ 280 KB RAM for the 28 KB WASM (`proton ram:buy paul123 xprconf 350000`).

```sh
node tests/testnet-demo.mjs init | register | deposit 3000 | fold alice | send 1234 | fold bob | withdraw 1000 | balances
```

Encoding: big-endian 32-byte words; G1 = (x, y); G2 = (x_im, x_re, y_im, y_re). The vk is
`alpha ‖ beta ‖ gamma ‖ delta ‖ IC[0..n]`, the proof is `A ‖ B ‖ C`, inputs are `32·n` bytes.
The contract negates A and checks `e(-A,B)·e(α,β)·e(vk_x,γ)·e(C,δ) == 1` with one
`alt_bn128_pair` call and `n` `alt_bn128_mul` + `alt_bn128_add` calls.

## Commands

```sh
npm install                       # proton-tsc, @proton/vert, typescript 4.9.5 (proton-asc needs TS 4)
npm run build                     # → assembly/target/{groth16,xprconf}.contract.{wasm,abi}
npm test                          # vert: T1 verifier checks + T3 end to end (needs ../../circuits/build)

# regenerate the fixture from the bench crate
(cd ../../bench && cargo run --release -- --emit-evm-fixture ../contracts/xpr-conf-tsc/tests/fixtures/groth16_2_evm.json)

# testnet
proton chain:set proton-test
printf 'y\n' | proton contract:set xprconf ./assembly/target
proton action xprconf verify "$(node tests/encode-fixture.mjs)" xprconf            # valid → "groth16: valid"
proton action xprconf verify "$(node tests/encode-fixture.mjs --tamper)" xprconf   # → assertion "invalid proof"
```

Gotchas found on the way: `as-chain`'s `U256.toString(16)` is wrong and its `modExp` wrapper
uses it, so `babyjub.ts` binds `mod_exp` directly; a contract needs ~10× its WASM size in RAM and
`contract:set` still deploys the ABI when setcode fails for RAM (check `get_code_hash`); `proton-asc` runs under ts-node and needs `typescript@4.9.5` (TS 7
breaks it); vert wires `contract.actions` asynchronously after `createContract`, so tests must
wait for it; a proof whose point is off-curve fails inside the host function
(`bn128Pair error`) rather than in the final check.
