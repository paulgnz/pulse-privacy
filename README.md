# Private XPR

Private payments with auditability on XPR Network. Version 2 (contract `xprshield`) hides who you
pay and how much; the payer's signature stays public and a viewing key held by the XPR Network
committee opens every payment. Private, not anonymous.

**Live:** <https://private.protonnz.com> runs version 1 on mainnet (contract `xprconf`, amount
hidden, parties visible); **deposits into v1 are paused since 2026-09-08**, withdrawals and
payments inside continue. <https://testnet.private.protonnz.com> runs version 2 on testnet, with
v1 at `/old`. Trusted-setup ceremony: <https://ceremony.private.protonnz.com>.

Start with [docs/00-overview.md](docs/00-overview.md): what is where, what is live, what is next.

---

## Version 1 (confidential, retiring)

## What it does

You deposit ordinary XPR or XMD into a contract. From then on your balance and every payment you
make are stored as encrypted numbers. The chain still records who paid whom and when. It no longer
shows how much. Three parties can read an amount: you, the other party, and the designated auditor.
Withdrawing turns the balance back into ordinary tokens.

- **Boxes you can add without opening.** Balances and payments are twisted ElGamal ciphertexts on
  Baby Jubjub. The contract adds and subtracts them without decrypting.
- **A proof with every payment.** A Groth16 proof (bn254, 46,874 constraints) shows the amount is
  in range, the sender is not overdrawn, and every copy of the box holds the same number. XPR
  Network verifies it on chain in about 12 ms using Leap's `CRYPTO_PRIMITIVES` intrinsics. Proving
  takes about two seconds in the browser.
- **Two keyholes on every box.** Each payment is encrypted to the receiver and to the auditor, and
  the proof enforces it. A payment the auditor cannot read cannot be created.
- **Your wallet is the key.** The user's encryption key is derived from a WebAuth signature over a
  fixed, never-broadcast message. There is nothing extra to back up.
- **Incoming box.** Payments to you land in a separate box and are added to your balance when you
  act, so a balance changes only under its owner's control.
- **Recovery.** Accounts whose wallet signs with a passkey keep a saved key instead of a derived
  one. They can store a passphrase-protected copy on chain to restore it on any device, and an
  encrypted copy that only the committee's viewing key opens. If a key is ever beyond recovery, the
  committee can pause the token and return the account's balance from escrow.

The full design, including the ELI5 walk-through, the threat model and the edge-privacy analysis,
is in [docs/01-design.md](docs/01-design.md). The mainnet operations record is
[docs/02-mainnet-runbook.md](docs/02-mainnet-runbook.md), and the internal security review with
its findings and fixes is [docs/03-security-review.md](docs/03-security-review.md).

## Status

This is early access. Read this before holding value in it.

| | |
|---|---|
| Proving key | From a one-person rehearsal until the public ceremony completes. Anyone can contribute at the ceremony site. |
| Review | Two adversarial reviews on 2026-09-07, findings and fixes in [docs/03-security-review.md](docs/03-security-review.md). No external audit yet. |
| Caps, set on chain | XPR: 10,000 per deposit, 100,000,000 in the contract. XMD: 100 per deposit, 100,000 in the contract. Withdrawals in whole units, except an exact final withdrawal that empties the box. The live figures are read from the contract on the site's How it works page. |
| Contract owner | `admin.proton@committee` (3 of 6). |
| Auditor key | Held for the committee. The public key is in the contract's config. |

## Repository

| directory | what it is |
|---|---|
| `contracts/xpr-conf-tsc/` | The contract, in proton-tsc (AssemblyScript): tables, actions, the Groth16 verifier and Baby Jubjub arithmetic over the chain's `alt_bn128_*` and `mod_exp` intrinsics. Tests run under vert. |
| `circuits/` | The transfer circuit (circom 2.2), the ElGamal client library, and the setup scripts. Withdrawals reuse the transfer circuit. |
| `dapp/` | The web app: Vite, React, `@proton/web-sdk`, snarkjs in the browser. Statement, send, deposit, withdraw, activity, auditor and settings. Design notes in `dapp/DESIGN.md`. |
| `ceremony/` | Trusted-setup tooling: contribute, verify, finalize with an XPR block beacon. Becomes the public transcript once the ceremony has run. |
| `ceremony-web/` | The browser-based contribution site (Vercel functions and Blob). |
| `tools/auditor-cli/` | Reads the ledger with the viewing key and reconciles escrow against deposits and withdrawals. |
| `bench/` | Groth16 versus Bulletproofs verifier benchmarks, native and in WASM under metering. |
| `docs/` | Design doc and mainnet runbook. |

## Building and running

Each part has its own README. In short:

```sh
# circuit: compile, run the rehearsal setup, test
cd circuits && npm install && npm run compile && npm run setup && npm test

# contract: build with proton-tsc, test under vert
cd contracts/xpr-conf-tsc && npm install && npm run build && npm test

# web app: simulated backend, no wallet needed
cd dapp && npm install && VITE_CRYPTO=mock npm run dev
# real backend against testnet
cd dapp && npm run dev
```

The dapp reads its network from `VITE_NETWORK` (`testnet` by default, `mainnet` for the main
site). Chain writes from scripts sign through the `proton` CLI keychain; no private key is ever
passed to a script or committed here.

## Security

Please report vulnerabilities privately through GitHub's security advisories for this repository
rather than in a public issue. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
