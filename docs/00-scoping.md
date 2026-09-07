# 64 — Privacy track: scoping (confidential transfers with auditability)

**Date:** 2026-09-07. **INTERNAL.** Builds on wiki/20 §2 (confidential balances = the one
real gap vs Tempo/Arc), wiki/21 (settlement-ledger thesis, Proof-of-Reserve), wiki/23 (wallet
key model), wiki/49 row 1 (the missing Antelope crypto intrinsics). This page is the scoping
record and the pointer; **the work lives in `~/dev/pulse-privacy`** (new repo, new chat
session). Intrinsic work lands on the pulsevm fork as a normal PR, cross-linked from there.

## 0. The decision in one paragraph

Build **confidentiality, not anonymity**: hidden *amounts*, visible *parties*, every amount
decryptable by the owner and by a designated **auditor viewing key**. Accounts stay named,
permissions stay Antelope, nothing existing changes. This is the institutionally defensible
line (it is what Arc advertises as "selective shielding with preserved auditability", and it
pairs with our "give the regulator a node" story). A full shielded pool with hidden
counterparties is technically the same building blocks plus nullifiers, but it is a Metallicus
**product and regulatory decision** in the same category as the consensus question (wiki/58):
we scope it as Phase 3 and do not build it unasked.

Feasibility: **yes.** The pairing code is literally already vendored in the tree, the
protocol-feature gate this needs merged in #51, and we have shipped 22 gated intrinsics before.
Timeline is **quarters, not weeks**, and Phase 2 needs an external audit before any
institutional use.

## 1. What "privacy" means here — levels and threat model

| Level | What is hidden | From whom | Status |
|---|---|---|---|
| L0 network boundary | everything | outsiders of a private subnet; validators see all | **today** (private subnet) |
| **L1 confidential amounts** | balances + transfer amounts | everyone except owner, counterparty, auditor | **target of this track** |
| L2 hidden counterparties | sender/receiver linkage | everyone except auditor | Phase 3, decision-gated |
| Private execution (TEE/FHE) | contract inputs/state generally | validators | **out of scope** |
| Network-level unlinkability (IP, timing) | who submitted | RPC/p2p observers | out of scope (client concern) |

Non-goals stated up front so nobody over-reads the word "privacy": no mixing, no untraceable
value, no hiding from the auditor, no change to how public tokens or existing contracts behave.

## 2. Substrate facts (verified 2026-09-07 against `upstream/main` and the local fork)

- **Host functions:** `crates/pulsevm_core/src/chain/webassembly/crypto.rs` exposes only the
  SHA family + recover_key etc. **None** of Antelope's `CRYPTO_PRIMITIVES` set exists
  (`alt_bn128_add/mul/pair`, `mod_exp`, `blake2_f`, `sha3`, `keccak`, `k1_recover`) — wiki/49
  row 1, still missing. Proof verification in plain WASM is 100×+ the native cost and would
  blow any per-tx CPU limit, so **intrinsics are mandatory, not an optimisation.**
- **Vendored crypto:** `crates/pulsevm_ffi/pulsevm/libraries/libfc/libraries/{bn256,bls12-381,boringssl}`
  are in the tree (C++ libfc) but unexposed. We will **not** route through the FFI: implement in
  Rust (`ark-bn254`/`ark-ec` or `blst`) so the host functions are pure-Rust like the rest of
  `webassembly/`.
- **Feature gating:** `crates/pulsevm_core/src/chain/protocol_features.rs` +
  `docs/protocol-features.md` (merged #51). Only `Baseline` exists, protocol version is `1`,
  version `2` is not scheduled anywhere. New intrinsics would be **the first real gated feature**
  and a live dogfood of the §8/§9 runbook (Cargo `protocol_feature_*` flag → `nightly`
  aggregate → `ProtocolFeature::CryptoPrimitives => 2`, then an `upgrade_bytes` schedule on a
  disposable chain).
- **CPU billing:** producer wall-clock, replayed objectively on verify/accept via
  `explicit_billed_cpu_time` (v0.5.1, `transaction_context.rs`). So an intrinsic's cost is
  *measured*, not tabulated: the verifier must sit comfortably inside the per-tx limit on the
  slowest validator class. Ballpark to be measured in Phase 0: bn254 Groth16 verify ≈ 1–2 ms
  native; Bulletproofs 64-bit range proof ≈ 1–3 ms. Remember #77: the u32 budget fields cap
  a tx at ≈113 ms, and #76's admission gap means an over-budget proof tx is *silently dropped*,
  not rejected — the wallet must never build one.
- **BLS12-381 is arriving anyway:** Glenn's #64 (Warp/ICM, open) brings a BLS crate into the
  tree. Align the pairing dependency with his choice — one pairing library in the binary, not two.
- **Antelope precedent:** Leap 3.1's `CRYPTO_PRIMITIVES` protocol feature added exactly this
  set for EOS-EVM and zk use. Shipping the **same signatures** means (a) wiki/49 row 1 closes,
  (b) contracts written against Leap's headers port unchanged, (c) any generic zk verifier
  (Proof-of-Reserve from wiki/21, bridges) is unlocked, independent of the confidential token.
- **Wallet:** `~/dev/pulse-wallet/core` is a Rust crate with a C ABI (wiki/23). The prover and
  viewing-key derivation live there. **Wrinkle:** the R1 / Secure Enclave signing key cannot do
  ECDH or export, so the viewing key is a *separate* derived secret (from the wallet seed), not
  the enclave key. Recovery of the viewing key = recovery of history; design it with the
  account-recovery flow, not after.

## 3. Target architecture (Phase 2 deliverable)

**Confidential token contract** (`pulse-cdt-rust`, sibling of `pulse_token`), one per
underlying public token, holding the public tokens in escrow.

- **State per account:** an encrypted balance (available), an encrypted *pending* credit
  bucket, the account's encryption pubkey. Encryption is a homomorphic scheme so the contract
  can add ciphertexts without decrypting (twisted-ElGamal-style: owner *and* auditor can
  decrypt, contract never can).
- **Actions:** `register` (publish encryption pubkey) · `deposit` (public → confidential,
  amount known, inline transfer into escrow) · `transfer` (sender proves, in zero knowledge:
  the amount is in range, the new sender balance is ≥ 0, and the three encryptions — to sender,
  receiver, auditor — encrypt the *same* amount) · `applypending` (receiver folds pending
  credits into available; this split is what stops a third party's incoming transfer from
  invalidating a proof the sender built a second earlier) · `withdraw` (confidential → public,
  proof of sufficient balance) · `configure` (auditor key rotation, via msig).
- **Auditor:** one global viewing key per token, held by the designated supervisor, rotatable.
  Every transfer is decryptable by it by construction (in-circuit consistency proof), so
  auditability is not opt-in per user.
- **Proof system — recommendation: Groth16 on bn254** via the `alt_bn128_*` intrinsics.
  Reasons: the intrinsics are the Antelope-standard set (a parity PR Glenn can accept on its
  own merits), one circuit ("confidential transfer") with one ceremony is manageable, proofs are
  ~200 B with ~1.5 ms verify, and the same intrinsics serve every other zk use. Trade-off is the
  trusted setup: mitigate with a public Powers-of-Tau plus a phase-2 ceremony with several
  contributors (Metallicus, BPs). **Fallback:** Bulletproofs on ristretto255 (no setup,
  Solana-Token-2022-proven) if the ceremony is unacceptable — it needs a bespoke range-proof
  host function instead, which is a harder upstream sell. Phase 0 benchmarks both.
- **Client:** prover in `pulse-wallet/core` (arkworks; seconds on a laptop, WASM build later
  for web wallets). Tx flow: wallet decrypts own balance → builds witness → proves → signs the
  ordinary Antelope tx with the R1/K1 key → issueTx. Auditor tool = CLI that decrypts a range of
  blocks with the viewing key (Hyperion "viewing-key mode" is a later nicety).
- **Explorer/Hyperion:** unchanged; they show ciphertexts. XPR-compat: zero change to existing
  behaviour — new gated intrinsics and a new contract only.

## 4. Phases and exit criteria

**Phase 0 — design doc + benchmark (1–2 weeks).** In `pulse-privacy/docs/`: threat model,
circuit spec, table/action spec, key-management spec. `bench/` micro-benchmarks of Groth16-bn254
and Bulletproofs verify natively on the Mac and on the `.95` box class. **Glenn conversation**
on the intrinsic set + first gated feature (see §6). *Exit:* proof system chosen with numbers;
Glenn agrees the intrinsic set and the gating approach.

**Phase 1 — intrinsics (3–4 weeks).** PR to pulsevm: the full Leap `CRYPTO_PRIMITIVES` set
under `ProtocolFeature::CryptoPrimitives` (version 2), Rust-native, Leap/EIP-196/197 test
vectors ported into `pulsevm_unittests`, `pulse-cdt-rust` + `pulse-tsc` bindings. Dogfood the
protocol-features runbook: schedule version 2 on a disposable chain, mixed-binary refusal test.
*Exit:* wiki/49 row 1 green; a contract-level Groth16 verifier verifies a real proof on the
disposable chain, measured CPU recorded.

**Phase 2 — confidential token (≈ one quarter).** Circuit + ceremony + contract + wallet
prover + auditor CLI. Deploy on a disposable subnet first, then the 1:1 demo chain (public
demo of hidden-amount transfers with an auditor decrypt). **External audit** of circuit and
contract before anything institutional touches it. *Exit:* deposit → transfer → withdraw
round-trip with auditor decrypt on the demo chain; throughput of confidential vs plain
transfers published.

**Phase 3 — decision-gated, doc only.** Either hidden counterparties (nullifier-based
shielded pool, auditor still sees everything) or the **private-zone** shape from wiki/20 §3: a
dedicated PulseVM L1 (wiki/44 substrate) running only the confidential token, anchored to the
settlement chain over Warp (#64). Needs a Metallicus product decision first.

## 5. Risks and open questions

- **Regulatory line.** Amount-hiding with a mandatory auditor key is the defensible design;
  the moment counterparties are hidden it is a different conversation. Keep Phase 3 a doc.
- **Front-running of proofs.** Handled by the pending/available split; still needs the
  "receiver applies pending" UX to be invisible in the wallet.
- **Key management.** Viewing key ≠ signing key; loss of viewing key = loss of readable
  history (funds still movable only if the wallet can decrypt the balance → it is also a
  *spending* precondition). Design recovery with the wallet's account-recovery flow.
- **CPU sizing.** Per-tx limit must hold on the weakest validator; #76/#77 mean an
  over-budget proof tx vanishes silently. Wallet-side pre-check against `getInfo` limits.
- **Dependency alignment with #64.** Pick the pairing crate after seeing Glenn's.
- **Ceremony operations.** Groth16 phase-2 needs a repeatable, published ceremony; if that is
  too heavy, Bulletproofs fallback (accepting the bespoke intrinsic).
- **Determinism.** Verifiers are deterministic by construction; the only risk is the
  wall-clock billing near the limit — same class as the wedge we already fixed, and why the
  verifier must be far from the ceiling.
- **Un-gated consensus changes upstream** (00-STATUS §2b): this track must not add to that;
  it is the reference example of a *gated* change.

## 6. Ask for Glenn (pending-send, one paragraph)

We want to add Leap's `CRYPTO_PRIMITIVES` host functions (`alt_bn128_add/mul/pair`,
`mod_exp`, `blake2_f`, `sha3`, `keccak`, `k1_recover`) as PulseVM's first post-genesis gated
feature (`ProtocolFeature::CryptoPrimitives` → version 2, per `docs/protocol-features.md`
§9), Rust-native with Leap's test vectors. It closes the last crypto row of the parity list
and unlocks zk verification in contracts — our use is a confidential-transfer token (hidden
amounts, auditor viewing key). Two things to align: which pairing crate #64 (Warp) brings in,
so we share one, and whether you want the schedule-version-2 dogfood done on a chain you run
or ours.

## 7. Working arrangement

- **Repo:** `~/dev/pulse-privacy` (off iCloud — the `~/Documents` git hangs are a known
  problem). Layout: `docs/` (this page as `00-scoping.md`, then the design doc), `bench/`,
  `circuits/`, `contracts/confidential_token/`, `prover/` (crate consumed by
  `pulse-wallet/core`), `tools/auditor-cli/`.
- **Intrinsics:** branch `feat/crypto-primitives` on `paulgnz/pulsevm`, PR upstream; the repo
  links to it, it does not vendor pulsevm.
- **Sessions:** a fresh chat session in the new repo does the design doc and benchmarks. This
  wiki keeps this page and a line in 00-STATUS; results come back here as one-line updates.
- **Order of operations:** design doc → benchmark → Glenn message → intrinsic PR → contract.
  Do not start the contract before the intrinsic set is agreed.
