# pulse-privacy

Confidential transfers with auditability for PulseVM / XPR Network: hidden amounts, visible
parties, mandatory auditor viewing key. Not a mixer.

Start with [docs/01-design.md](docs/01-design.md) — the ELI5 walk-through, the answer to
"bolt-on or private chain" (bolt-on), the full cryptographic/contract design, and the corrections to
the scoping page. [docs/00-scoping.md](docs/00-scoping.md) is the original scoping record, mirrored
from migration wiki page 64. Numbers come from [bench/README.md](bench/README.md).

**Live testnet dapp:** <https://private.protonnz.com> (real proofs in the browser, WebAuth
signing, contract `xprconf` on XPR testnet; Vercel project `pulse-privacy`, `cd dapp && vercel --prod`).
Custom domain `private.protonnz.com` pending DNS (see dapp/README.md).

Explainer film (ELI5 + engineer layer, 140 s, Brian VO): Remotion module
`~/dev/remotion-videos/src/ConfidentialTransfers/` → `out/ConfidentialTransfers.mp4`.

Order of operations: design doc ✓ → benchmark ✓ (Mac; `.95` box pending) → Glenn message
(draft in design doc §10) → intrinsic PR on `paulgnz/pulsevm` (`feat/crypto-primitives`) → contract.

Layout (empty until the phase that fills it):

- `docs/` — scoping (00), design doc incl. threat model and key management (01), mainnet runbook (02)
- `ceremony/` — trusted-setup tooling (contribute / verify / finalize) and, once run, the public transcript
- `bench/` — Groth16-bn254 vs Bulletproofs verifier micro-benchmarks, native and in WASM under
  wasmer with pulsevm's metering (`bench/`, `bench/wasm-guest/`, `bench/wasm-host/`)
- `circuits/` — confidential-transfer circuit + ceremony artefacts
- `contracts/xpr-conf-tsc/` — testnet build in proton-tsc: the confidential token is **live on XPR testnet account `xprconf`** (deposit → proven send → proven withdraw exercised); `contracts/` later also holds the pulse-cdt-rust port
- `circuits/` — the transfer circuit (circom), the ElGamal client library, ceremony rehearsal
- `dapp/` — the front end (WebAuth login, balances, send/receive/withdraw, auditor mode)
- `prover/` — Rust crate consumed by `pulse-wallet/core`
- `tools/` — auditor CLI
