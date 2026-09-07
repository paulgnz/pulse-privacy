# circuits — confidential-transfer circuit (T2)

The statement from [`docs/01-design.md`](../docs/01-design.md) §2.4 in **circom 2**, with a
JS client library for twisted ElGamal on Baby Jubjub that matches the circuit exactly. The
same `snarkjs` prover runs in Node (tests, auditor CLI) and in the browser (dapp).

| item | value |
|---|---|
| curve (proof) | bn254, Groth16 |
| curve (encryption) | Baby Jubjub; `G` = circomlib `Base8`, `H` = hash-to-curve(`pulse-privacy/babyjubjub/H/v1`), cofactor-cleared (`scripts/gen-h.mjs`, output committed) |
| amounts | 64-bit as two 32-bit chunks; old-balance chunks may be un-normalised up to 40 bits |
| constraints | **46,874 non-linear** (+924 linear), 41 public inputs, 11 private, fits a 2^16 ceremony |
| public input order | `Ps Pr Pa BoldC BoldD BnewC BnewD TC TDs TDr TDa nonce sender receiver` (points as x,y; chunk index 0 = lo) |
| witness | `s vold[2] v[2] vnew[2] rT[2] rN[2]` |

## Layout

```
transfer/transfer.circom     the statement (MulAny / MulFix / Commit helpers over circomlib)
transfer/generators.circom   GENERATED: G, H constants
lib/generators.json          GENERATED: same constants for JS
lib/elgamal.mjs              keygen, encrypt, decrypt (BSGS 2^16 table), split/join, buildTransferWitness
lib/encode.mjs               snarkjs vk/proof/signals → the proton-tsc verifier's byte layout
scripts/gen-h.mjs            derive H (run once)
scripts/setup.mjs            Groth16 phase-2 REHEARSAL (one local contribution)
test/transfer.test.mjs       end to end: witness → decrypt → prove → snarkjs verify → vert (T1 contract)
build/                       gitignored: r1cs, wasm, ptau, zkeys, vk, payload
```

## Commands

```sh
npm install
npm run compile                       # circom → build/transfer.r1cs + build/transfer_js/transfer.wasm

# Powers of Tau (2^16). The public Hermez file is preferred; if the mirrors are down, a local
# one is fine for the rehearsal:
npx snarkjs powersoftau new bn128 16 build/pot16_0000.ptau
echo "entropy" | npx snarkjs powersoftau contribute build/pot16_0000.ptau build/pot16_0001.ptau --name=r1
npx snarkjs powersoftau prepare phase2 build/pot16_0001.ptau build/pot16.ptau

npm run setup                         # phase-2 rehearsal → build/transfer_final.zkey, build/transfer_vk.json
npm test                              # full pass; add --witness-only to skip proving
```

The real ceremony (§2.8) replaces `scripts/setup.mjs` with ≥ 5 independent contributions on the
published Powers-of-Tau and published transcripts; the circuit and vk format do not change.

## Notes

- `nonce`, `sender`, `receiver` are bound by trivial multiplications so the optimiser keeps them.
- A wrong key does not decrypt: `bsgs32` throws because the point is not a small multiple of G.
- The BSGS table (65,536 entries) takes ≈ 4.5 s to build in Node; cache it per session.
