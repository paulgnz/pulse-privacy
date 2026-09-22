# Private XPR

Private payments with auditability on XPR Network. A payment hides **who was paid and how much**;
the chain shows only that the payer made a payment. Deposits and withdrawals stay public, and the
XPR Network committee's viewing key opens every payment. Private, not anonymous.

**Live on mainnet since 2026-09-22:** <https://www.privatexpr.com> (contract `privatexpr`).
Testnet: <https://testnet.privatexpr.com> (contract `xprshield`). Trusted-setup ceremony and its
transcript: <https://ceremony.privatexpr.com>. The previous version (v1, contract `xprconf`,
amount hidden but parties visible) is closed to deposits and stays withdrawable at
<https://www.privatexpr.com/old>.

Start with [docs/00-overview.md](docs/00-overview.md): what is where, what is live, what is next.

## How it works

- **Notes.** Money inside the contract is held as sealed notes. Each note is a commitment (Poseidon
  hash of owner key, amount, token and a random value) placed as a leaf of a Merkle tree on chain.
  Nobody but the owner can tell which notes are theirs or what they hold.
- **Spending with a proof.** A payment spends up to two notes and creates two new ones (to the
  receiver, and change). A Groth16 proof (bn254, circuit revision 6: 31,708 constraints, 28 public
  inputs) shows the notes exist in the tree, belong to the sender, add up, and have not been spent
  before (each spend publishes a nullifier). The contract verifies it on chain in about 17 ms of
  CPU. Proving takes about a second on a laptop.
- **Sealed to the receiver and the auditor.** Every new note is encrypted to its receiver and to
  the committee's viewing key, and the proof enforces both. A payment the auditor cannot open
  cannot be created.
- **Signed by the payer.** The payer's own account signs every payment, as with any XPR transfer;
  there is no relayer. The payer's name is public, the receiver and amount are not.
- **Deposits and withdrawals** move ordinary XPR or XMD in and out and are public.
- **Recovery.** Each account's key can be restored from a seven-word phrase copy or a committee
  copy, both stored encrypted on chain, or from a key file.
- **Capacity.** Trees hold 2^20 leaves each; the contract opens a new tree when one is full, and
  notes in closed trees stay spendable.

Full design: [docs/06-shielded-design.md](docs/06-shielded-design.md). Launch runbook and record:
[docs/07-private-xpr-v2-mainnet.md](docs/07-private-xpr-v2-mainnet.md).

## Status

Early access. Read this before holding value in it.

| | |
|---|---|
| Proving key | From a public two-phase ceremony: 14 contributors in phase 1, 16 in phase 2 (one of them offline), each phase sealed with an XPR mainnet block announced in advance. Record: [ceremony/TRANSCRIPT.md](ceremony/TRANSCRIPT.md). |
| Review | Internal adversarial reviews and seventeen independent passes, findings and fixes in [docs/03-security-review.md](docs/03-security-review.md). **No external audit yet.** |
| Caps, set on chain | XPR: 10,000 per deposit, 1,000,000 in the contract. XMD: 100 per deposit, 100,000 in the contract. |
| Contract account | `privatexpr@active`: 2 of 3 separate signers (plus the contract's own `eosio.code`). `privatexpr@owner`: `admin.proton@committee` (3 of 6). |
| Auditor key | Generated offline for the committee on 2026-09-22; only its public key is on chain and pinned in the app and client. |

## Repository

| directory | what it is |
|---|---|
| `contracts/xpr-shield-tsc/` | The v2 contract (proton-tsc): note tree, root ring, nullifiers, Groth16 verifier over the chain's `alt_bn128` intrinsics, deposits, withdrawals, recovery rows. Tests under vert, including fuzzing and the tree-rollover regression. |
| `circuits/` | `shielded/joinsplit.circom` (v2) and the note library `lib/notes.mjs`; `transfer/` is the v1 circuit. |
| `dapp/` | The web app (Vite, React, `@proton/web-sdk`, snarkjs in the browser): statement, send, deposit, withdraw, activity, auditor, settings; v1 withdrawals at `/old`. |
| `client/` | Headless client: the whole product from a terminal, including the committee's audit and recovery. See [client/README.md](client/README.md). |
| `ceremony/` | Trusted-setup tooling (contribute, verify, finalize with an XPR block beacon) and the ceremony's public record. |
| `ceremony-web/` | The browser-based contribution site (Vercel functions and Blob). |
| `contracts/xpr-conf-tsc/`, `tools/auditor-cli/` | v1 contract and its auditor tool (legacy, withdrawals only). |
| `bench/` | Groth16 versus Bulletproofs verifier benchmarks. |
| `tests/` | Repository-wide security regressions. |
| `docs/` | Designs, runbooks, security review. |

## Building and running

```sh
# circuit: compile revision 6
cd circuits && npm install && npm run compile:shielded

# contract: build with proton-tsc, test under vert
cd contracts/xpr-shield-tsc && npm install && npm run build && npm test

# web app: simulated backend, no wallet needed
cd dapp && npm install && VITE_CRYPTO=mock npm run dev
# against testnet (default) or mainnet
cd dapp && npm run dev
VITE_NETWORK=mainnet npm run dev

# headless client
node client/privatexpr.mjs
```

Verify the proving key yourself: the circuit compiles deterministically (the r1cs hash is in the
transcript), and `node ceremony/verify.mjs` or `snarkjs zkey verify` checks the final key against
it and the ceremony's contributions.

Chain writes from scripts sign through the `proton` CLI keychain; no private key is ever passed to
a script or committed here.

## Security

Please report vulnerabilities privately through GitHub's security advisories for this repository
rather than in a public issue. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
