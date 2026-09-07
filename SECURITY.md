# Security

Confidential XPR is in early access on mainnet, unaudited, and running on a rehearsal proving key
until the public ceremony completes. The on-chain caps bound what is at stake in the meantime.

## Reporting

Please report vulnerabilities privately through this repository's GitHub security advisories
("Report a vulnerability" under the Security tab). Do not open a public issue for anything that
could be exploited before it is fixed. You will get an acknowledgement within a few days.

## Scope

- `contracts/xpr-conf-tsc/assembly/*.ts`: the contract, the Groth16 verifier, Baby Jubjub arithmetic
- `circuits/transfer/transfer.circom` and `circuits/lib/elgamal.mjs`: the statement being proved and the client cryptography
- `dapp/src/lib/crypto/*` and `dapp/src/lib/unlock.ts`: browser-side proving and key derivation
- `ceremony/` and `ceremony-web/`: the trusted setup

Findings that would let anyone forge a proof, read an amount without a key, spend from a balance
they do not own, or break the auditor's ability to read a payment are the most serious.

## Out of scope

- Edge privacy at deposit and withdrawal. Amounts entering and leaving the contract are public by
  design; the design doc's section 1.9 describes what leaks there and what the app does about it.
- Availability of third-party services (API nodes, Hyperion indexers, Vercel).
