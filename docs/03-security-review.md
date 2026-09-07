# 03 — Internal security review (2026-09-07)

An adversarial review of the contract, the circuit and client library, the dapp's key handling,
and the ceremony, done before the external audit. Each area was reviewed independently against
a written brief to break it; every finding was then checked by hand before anything was changed.
This page records what was found, what was fixed the same day, and what is deliberately deferred.

## Fixed

| # | area | finding | fix |
|---|---|---|---|
| 1 | contract, **critical** | `keyMatches` compared only the compressed form (y and the sign of x) of the receiver's and auditor's keys, and the circuit does no on-curve check. A sender could pass an off-curve point with the same compressed form; the proof verifies, the receiver's pending box gets an unusable handle, and after folding the receiver can never prove again. Same trick on the auditor key makes a payment unreadable. | `keyMatches` requires the full key to be a non-identity point on the curve; every point in `t` and `b_new` must be canonical (coordinates below the field modulus) and on the curve. Tests cover a forged compressed-equal key and a non-canonical coordinate. Redeployed to testnet and mainnet (code `0e163521…`); a mainnet send after the redeploy costs 12.7 ms. |
| 2 | contract, high | Coordinates in `t` and `b_new` were only length-checked; the verifier reduces scalars mod the field, so `x + k·p` verified and then overflowed the on-chain point addition. | Covered by the canonical check in 1. |
| 3 | contract, low | The pool counter started at zero when limits were first set, so pre-existing escrow was not counted. | `setpool` admin action to set the counter to the actual escrow. |
| 4 | ceremony, **critical** | A contribution was never checked to extend the current head: a contributor could upload a file built from the initial file plus only their own secret, discarding everyone else's randomness, and the transcript would still verify. | The server reads the contribution records inside both files, requires the upload to carry every earlier record unchanged plus exactly one new one, and runs snarkjs's full verification against the ceremony start before recording. The contribution hash is read from the file, not taken from the client. `verify.mjs` does the same for every step. |
| 5 | ceremony, **critical** | The published final files were not tied to the last contribution or to the beacon; the coordinator could substitute a private chain. | `verify.mjs` recomputes the beacon step (and phase-1 preparation) from the last attested file and the block id, confirmed by several RPCs, and requires a byte-identical result. `finalize.mjs` takes the block id only when independent RPCs agree and the id encodes the height. |
| 6 | ceremony, high | Taking or releasing the turn was unauthenticated: anyone could kill an in-progress contribution or hold the lock forever under any name. | Taking a turn requires the account's signature over a timestamped note; releasing requires a token handed only to the holder's browser (stored hashed, since state files are public). |
| 7 | ceremony, medium | State writes were check-after-write, so two concurrent writers could both succeed and a contribution vanish. | Every version is written to a fixed name with overwriting refused, which makes the write a compare-and-set. State listing walks every page. |
| 8 | ceremony, medium | A client upload token could overwrite an already recorded file. | Tokens are refused for any path that is part of the transcript; retries are allowed only before a file is recorded. |
| 9 | ceremony, low | WebAuthn keys on an account's permissions made key parsing throw, so accounts with a passkey could not attest at all. Admin token compared with `!==`. CLI passed entropy on the command line. | Unsupported key types are skipped; `timingSafeEqual`; the CLI contributes in-process. |
| 10 | dapp, medium | Activity rows from the indexer were trusted as-is; a spoofed indexer could show a payment that never happened. | The newest incoming payments are confirmed against the chain's own block before they are shown. |
| 11 | dapp, medium | Importing a secret in Settings replaced the saved key without checking it matches the key registered on chain. | The import is refused unless the secret produces the registered key. |
| 12 | dapp, medium | No content security policy; saved keys and the pasted auditor key were one injected script away from exfiltration. | Content security policy (no inline or third-party scripts, wasm allowed, fonts from Google, no framing), plus `nosniff` and a referrer policy. |
| 13 | dapp, low | Sign-out left "key derived" state behind; one undecryptable row blanked the auditor ledger; error text included the decrypted balance. | All three fixed. |

## Accepted for now, with the reason

- **The wallet relay sees the key-deriving signature.** The signature over the never-broadcast
  `viewkey` transaction travels from the wallet to the site through the wallet-link relay, so the
  relay operator could derive a user's viewing key (read, not spend: spending still needs the
  wallet's own signature on chain). This is inherent to deriving the key from a wallet signature
  outside the wallet. The planned fix is derivation inside WebAuth (design §2.7). Until then it is
  a stated trust assumption, and the same applies to any site that could get a user to sign the
  identical message.
- **K1 signatures are assumed deterministic.** First-time setup skips the second confirming
  signature for wallets with a K1 key. Every real user so far has re-derived the same key across
  sessions and devices, which is the expected behaviour of RFC 6979 signing, but it is not
  verified per wallet. If it were ever false for a wallet, that user's boxes would be unreadable
  after the first session. The second signature can be restored with a one-line change.
- **A balance chunk above 2^40 units cannot be spent.** Incoming payments accumulate in the low
  chunk without normalisation, and the circuit bounds the old balance chunk to 40 bits. Reaching
  it needs about 110 million XPR received without a single send, above the current pool cap.
  The fix (a wider bound and a cap on pending count) is a circuit change, and belongs with the
  ceremony so it does not need a second one.
- **The token symbol is not a public input of the proof.** A sender's own proof would verify for
  another token only if the balance ciphertexts and nonce coincided exactly; it spends real
  balance in each and cannot move value to anyone else. To be bound in the same circuit change.
- **Deposits to another account's unregistered token row cost the contract RAM**, bounded by
  registered accounts times tokens (two today).
- **Secrets for passkey accounts live in localStorage.** Those accounts are rare; the CSP now
  limits exposure. In-wallet derivation removes the need.

## Verified sound

The proof binds sender, receiver, nonce, the old balance ciphertext, the new ciphertexts and the
three keys; every constraint of the transfer statement in design §2.4 is enforced with `===`;
withdrawals bind the public amount to the ciphertext; replay across nonce and fold is blocked;
the token contract of a deposit is checked; the never-broadcast unlock transaction cannot be
broadcast (expiration beyond the chain's limit, no TaPoS); the ceremony's attestation cannot be
replayed across index, phase or file; entropy never leaves the contributor's browser; analytics
carry no account, amount or key.

## Second pass: independent review (Codex, same day)

An independent reviewer worked the briefs in [04-review-briefs.md](04-review-briefs.md) against
commit `cf13819`; its report is [05-independent-review-handoff.md](05-independent-review-handoff.md).
It found no new way to steal or inflate funds, confirmed the contract suite, and reported eight
operational findings. Each was reproduced against the code and fixed the same day.

| # | area | finding | fix |
|---|---|---|---|
| 1 | ceremony, high | Anyone naming the lock holder could obtain an upload token and delete the upload in progress. | The upload token requires the lock token that only the holder's browser has. |
| 2 | ceremony, high | `verify.mjs` printed "ceremony verified" on an empty directory: missing final files or beacon metadata merely skipped checks. | Strict by default: both phases, a minimum number of signed contributions, final files, beacon metadata and the vk are required, or it fails. `--partial` checks what exists and never claims completion. |
| 3 | ceremony, high | Signatures were compared to a signer key in the same editable JSON; the actor was not bound to the signed transaction. | The expected transaction is rebuilt from actor, phase, index and file hash, must match the recorded one, and the recovered key must be one the account holds on chain, per at least two agreeing RPCs. |
| 4 | dapp, medium | The fold was bundled with the proof, so anyone paying the sender between proving and execution invalidated the proof. | The proof is built against the available balance only; when that is short, the fold goes out first as its own transaction and the row is re-read. |
| 5 | dapp, medium | Chain confirmation of incoming rows checked the parties but not the ciphertext, so an indexer could show a real payment with a forged amount; timeouts silently kept rows. | The ciphertext must match the block byte for byte; rows the chain could not be asked about are labelled as unchecked. |
| 6 | dapp, medium | Sign-out left notifications, optimistic rows and scheduled refreshes behind for the next account in the same tab. | All account state is cleared, timers cancelled, and in-flight refreshes from the previous session cannot write results. |
| 7 | ceremony, low | Moving to phase 2 recorded the last contribution instead of the prepared phase-1 result. | The phase-2 transition names the prepared file explicitly and records its hash. |
| 8 | ceremony, low | The setup record was counted as a contribution and failed its own chain check. | Start files carry index 0 and form the base of the chain. |

## Added after the reviews (same day)

- **Committee restore** (`restore`, contract code `dc7ab97d…`): paused-only, contract authority,
  returns an account's balance from escrow as a public transfer with a memo and resets its
  boxes. Procedure in the runbook §4c.
- **Recovery copy** for saved keys: an ECIES copy of the secret encrypted to the auditor's key,
  stored on chain with the registration (`setrecovery`), returned by the committee after the
  owner proves control of the account. Gives the committee nothing new: it already reads every
  amount, and spending still needs the wallet's signature. Saved-key users see a warning on the
  statement until they have a recovery copy or an export.

## Still to do before raising the caps

External audit of the contract, the circuit and the client library; the circuit change above;
in-wallet key derivation; the real ceremony followed by `setvk`.
