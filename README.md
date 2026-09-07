# pulse-privacy

Confidential transfers with auditability for PulseVM / XPR Network: hidden amounts, visible
parties, mandatory auditor viewing key. Not a mixer.

Start with [docs/01-design.md](docs/01-design.md) — the ELI5 walk-through, the answer to
"bolt-on or private chain" (bolt-on), the full cryptographic/contract design, and the corrections to
the scoping page. [docs/00-scoping.md](docs/00-scoping.md) is the original scoping record, mirrored
from migration wiki page 64. Numbers come from [bench/README.md](bench/README.md).

Order of operations: design doc ✓ → benchmark ✓ (Mac; `.95` box pending) → Glenn message
(draft in design doc §10) → intrinsic PR on `paulgnz/pulsevm` (`feat/crypto-primitives`) → contract.

Layout (empty until the phase that fills it):

- `docs/` — scoping (00), design doc incl. threat model and key management (01)
- `bench/` — Groth16-bn254 vs Bulletproofs verifier micro-benchmarks, native and in WASM under
  wasmer with pulsevm's metering (`bench/`, `bench/wasm-guest/`, `bench/wasm-host/`)
- `circuits/` — confidential-transfer circuit + ceremony artefacts
- `contracts/` — confidential token (pulse-cdt-rust)
- `prover/` — Rust crate consumed by `pulse-wallet/core`
- `tools/` — auditor CLI
