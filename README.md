# pulse-privacy

Confidential transfers with auditability for PulseVM / XPR Network: hidden amounts, visible
parties, mandatory auditor viewing key. Not a mixer.

Start with [docs/00-scoping.md](docs/00-scoping.md) (the scoping record, mirrored from the
migration wiki page 64). Order of operations: design doc → benchmark → Glenn message →
intrinsic PR on `paulgnz/pulsevm` (`feat/crypto-primitives`) → contract.

Layout (empty until the phase that fills it):

- `docs/` — scoping, design doc, threat model, key-management spec
- `bench/` — Groth16-bn254 vs Bulletproofs verifier micro-benchmarks
- `circuits/` — confidential-transfer circuit + ceremony artefacts
- `contracts/` — confidential token (pulse-cdt-rust)
- `prover/` — Rust crate consumed by `pulse-wallet/core`
- `tools/` — auditor CLI
