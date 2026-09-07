# bench — verifier micro-benchmarks (Phase 0)

Answers two questions for the confidential-transfer track:

1. **What does a validator pay to verify one confidential transfer**, natively (as an
   intrinsic) and inside the contract WASM (no intrinsic)?
2. **Groth16-bn254 or Bulletproofs?** — verify cost, proof size, prove cost.

Three crates:

| crate | what it measures |
|---|---|
| `bench/` (this crate) | native Rust: bn254 primitives = Leap `alt_bn128_*`, Groth16 verify by public-input count, Baby Jubjub ciphertext ops, Bulletproofs range-proof verify, wallet-side decrypt (BSGS) |
| `wasm-guest/` | the same verifiers compiled to `wasm32-unknown-unknown` |
| `wasm-host/` | runs the guest under **wasmer 7.0.1 with pulsevm's exact metering middleware and cost function** (`COST_FUNCTION`, `CPU_SCALE = 143`, copied from `pulsevm_core/src/chain/wasm_runtime.rs`), both the cranelift and the LLVM-aggressive backend pulsevm uses |

## Run

```sh
# native
cd bench && cargo run --release                 # markdown tables on stdout
cargo run --release -- --iters 500

# WASM (fixtures first, then guest, then host)
cargo run --release -- --emit-fixtures fixtures
(cd wasm-guest && cargo build --release --target wasm32-unknown-unknown)
(cd wasm-host && LLVM_SYS_211_PREFIX=/opt/homebrew/opt/llvm@21 cargo run --release --features llvm -- \
    ../wasm-guest/target/wasm32-unknown-unknown/release/pulse_privacy_wasm_guest.wasm)
# without LLVM installed: drop --features llvm and the env var; cranelift only
```

The `.95` validator-class box has not been run yet; run the native binary there and paste the
tables below (`rustup target add wasm32-unknown-unknown` for the guest; LLVM 21 for the host).

## Results — Apple M4 (MacBook Air), 2026-09-07

Single thread, medians of 200 iterations. Full output: run the commands above.

### A. bn254 primitives, native (arkworks 0.5) — what the intrinsics would cost

| operation | median | maps to |
|---|---:|---|
| G1 add | 1.7 µs | `alt_bn128_add` |
| G1 scalar mul | 42 µs | `alt_bn128_mul` |
| pairing check, 1 pair | 295 µs | `alt_bn128_pair` |
| pairing check, 2 pairs | 381 µs | `alt_bn128_pair` |
| pairing check, 4 pairs | 643 µs | `alt_bn128_pair` as called by a Groth16 verifier |

### B. Groth16 verify on bn254, native, by public-input count

| public inputs | median verify | proof | vk |
|---:|---:|---:|---:|
| 8 | 0.79 ms | 128 B | 520 B |
| 24 | 1.69 ms | 128 B | 1032 B |
| 64 | 3.92 ms | 128 B | 2312 B |

Verify cost is `n_pub` G1 scalar muls + one 4-pair pairing; the circuit's constraint count is
irrelevant to the verifier. With the standard trick of exposing **one** public input (a Poseidon
hash of all public values, recomputed by the contract) the on-chain cost is the 8-input row or
better: **≈ 0.8 ms native**. Prove time for the 20k-constraint stand-in was 0.18 s (laptop).

### C. Baby Jubjub (ed-on-bn254) — the ElGamal curve

| operation | native | in WASM (LLVM) | note |
|---|---:|---:|---|
| point add (projective) | 0.12 µs | 0.29 µs | contract: ~8 per transfer (homomorphic update) |
| point add + normalise | 1.6 µs | 4.1 µs | if the table stores affine points |
| scalar mul | 34 µs | — | wallet: encrypt = 2–3 per chunk |
| BSGS table build, 2^16 | 15 ms | — | wallet, once, cacheable |
| decrypt one 32-bit chunk, worst case | 12.5 ms | — | wallet-side |

### D. Bulletproofs on ristretto255 (dalek), native

| proof | verify | size | prove |
|---|---:|---:|---:|
| 32-bit × 1 | 0.35 ms | 608 B | 2.6 ms |
| 64-bit × 1 | 0.60 ms | 672 B | 4.8 ms |
| 64-bit × 2 (aggregated) | 1.03 ms | 736 B | 9.2 ms |
| 64-bit × 4 (aggregated) | 1.70 ms | 800 B | 18 ms |

A transfer needs at least two range proofs (amount, remaining balance) plus sigma protocols for
ciphertext validity/equality, so the Bulletproofs path lands at **≈ 1.2–2 ms verify and
≈ 1 KB of proof**, versus **0.8 ms and 128 B** for Groth16.

### E. The same verifiers inside contract WASM under wasmer + pulsevm metering

| export | wall / iter (cranelift) | wall / iter (LLVM, pulsevm config) | points / iter | **billed** (points / 143) | % of 150 ms tx limit |
|---|---:|---:|---:|---:|---:|
| Groth16 verify, 8 inputs | 3.96 ms | 2.85 ms | 251.8 M | **1 761 ms** | 1 174 % |
| Groth16 verify, 24 inputs | 6.27 ms | 4.42 ms | 392.9 M | 2 747 ms | 1 832 % |
| Groth16 verify, 24 inputs, prepared vk | 5.00 ms | 3.49 ms | 312.9 M | 2 188 ms | 1 459 % |
| Baby Jubjub add (projective) | 0.39 µs | 0.29 µs | 29 k | 0.20 ms | 0.14 % |
| Baby Jubjub add + normalise | 4.7 µs | 4.1 µs | 183 k | 1.28 ms | 0.9 % |
| Bulletproofs 64-bit verify | 2.07 ms | 1.30 ms | 114.3 M | 799 ms | 533 % |

## What the numbers say

1. **Wall-clock, WASM is only 3–4× native.** wasmer-LLVM does well on this code. The "100×+"
   figure in the scoping page is wrong for pulsevm's runtime. On Leap (wall-clock billing,
   EOS-VM-OC) a pure-WASM Groth16 verifier would be a ~4 ms action.
2. **Billed cost is the real wall.** pulsevm bills instruction points ÷ 143, and the scale was
   calibrated on a DB-heavy contract (`placeorder`). Pure field arithmetic is billed at roughly
   **600× its wall-clock**: a 2.85 ms verify bills 1.76 s, twelve times the whole per-tx limit.
   So on PulseVM the intrinsics are mandatory for the **proof**, full stop — not as an
   optimisation but because the metering makes a WASM verifier unbillable.
3. **The contract-side ElGamal arithmetic can stay in WASM.** Eight projective Baby Jubjub adds
   per transfer bill ≈ 1.6 ms. Acceptable, though the same 600× over-billing applies; if the
   contract stores affine points it is ≈ 10 ms billed per transfer, so store projective/extended
   coordinates or normalise once per action.
4. **Side finding for the PulseVM maintainers (separate from this track):** `CPU_SCALE = 143` under-bills DB-heavy
   and massively over-bills compute-heavy contracts. Any contract doing hashing or big-int
   arithmetic in a loop (bridges, light clients, on-chain crypto) will hit this. Worth a
   per-opcode-class recalibration or a different cost table for arithmetic ops.
5. **Groth16 wins on every verifier axis** (0.8 ms vs ≈1.5 ms billed, 128 B vs ≈1 KB, one
   standard intrinsic set vs a bespoke one). Bulletproofs' only advantage is no trusted setup.
   Groth16 recommended; the ceremony is the price.
