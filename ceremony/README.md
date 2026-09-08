# Ceremony — trusted setup for the shielded join-split circuit

Phase 1 (powers of tau) is universal and was started for the confidential transfer circuit; it
serves the shielded join-split circuit unchanged, which is the circuit phase 2 is run for now that
shielded replaces confidential (docs/06 §8.5). The transfer circuit keeps its rehearsal key.

The Groth16 proving key needs a multi-party setup. As long as **one** contributor destroyed
their randomness, nobody can forge proofs. The testnet key came from a one-person rehearsal
and must not be used for value. This directory is the ceremony's tooling and, once it has run,
its public record.

Two phases, same contributors, same one-line command:

| phase | what it is | starts from | contributor runs |
|---|---|---|---|
| 1 | universal "Powers of Tau", 2^16 (the public Hermez file would do, but its mirrors are not reachable, so we run our own) | `snarkjs powersoftau new bn128 16` by the coordinator | `node contribute.mjs prev.ptau NN-you.ptau --name "You @ Org"` |
| 2 | circuit-specific, for `circuits/shielded/joinsplit.circom` revision 5 (31,659 constraints) | `finalize.mjs setup` after phase 1 | `node contribute.mjs prev.zkey NN-you.zkey --name "You @ Org"` |

Each contribution is sequential (you receive the previous file, add your randomness, pass the
result on) and takes a minute or two on a laptop. Files are ≈ 25 MB (ptau) and ≈ 25 MB (zkey).

## For contributors

1. Install Node 20+, then in a fresh directory: `npm init -y && npm i snarkjs@0.7`; copy
   `contribute.mjs` next to it (or clone this repo and `npm install` in `ceremony/`).
2. Receive `NN-prev.ptau` (or `.zkey`) from the coordinator and check its sha256 against the
   coordinator's announcement.
3. Run the command above. Type a long random sentence when asked. Ideally on a machine you then
   reboot; an air-gapped laptop with the file on a USB stick is ideal but not required.
4. Publish the JSON the script prints (your name, output sha256, contribution hash) somewhere
   public you control (a tweet, a post, a signed message from your XPR account), and send the
   output file plus its `.json` to the coordinator.

## For the coordinator

```sh
cd ceremony && npm install
# phase 1
npx snarkjs powersoftau new bn128 16 contributions/00-start.ptau -v
#   … contributors 01..N, sequentially …
node finalize.mjs phase1 contributions/NN-last.ptau --beacon-block <announced height>
# phase 2
(cd ../circuits && npm run compile)             # deterministic; publish the r1cs sha256
node finalize.mjs setup ../circuits/build/joinsplit.r1cs
#   … contributors 01..N, sequentially …
node finalize.mjs phase2 contributions/NN-last.zkey --beacon-block <announced height>
node verify.mjs                                 # anyone can run this
```

The **beacon** is the XPR mainnet block id at a height announced publicly *before* the last
contribution (`RPC` defaults to https://proton.protonnz.com). The final artefacts land in
`final/`: `pot16_final.ptau`, `joinsplit_final.zkey` (ships in the dapp under
`public/circuit/` as `joinsplit-r4_final.zkey`), `joinsplit_vk.json`, and `vk.hex` for `setvk` on xprshield.

Publish: every `contributions/*.json`, the two `final/*.json`, the final files' hashes, and the
r1cs hash, in this directory. Contributors' public attestations are linked from
`TRANSCRIPT.md`.

## Minimum bar before mainnet

- ≥ 5 independent contributors per phase (Metallicus, three or more block producers, one
  outside party), each with a public attestation.
- `node verify.mjs` passes from a clean checkout.
- The vk hash installed with `setvk` equals `final/phase2.json → vk`.
