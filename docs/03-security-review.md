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

## Exposure check before going public (same day)

A third pass looked only at what becoming public would expose. No credential in the tree or in
any commit. Three follow-ups, all applied:

- **Passphrase backups are public ciphertext**, so a weak passphrase could be guessed offline.
  The wizard now generates a seven-word phrase (77 bits, from the 2,048-word BIP39 list) by default; a custom passphrase
  needs 14 characters and several words, and common patterns are refused. PBKDF2 stays at
  600,000 rounds.
- **Dependency advisories** in the projects' lockfiles: the non-breaking fixes are applied.
  What remains is in build-time tooling (the AssemblyScript compiler's templating library, the
  circuit compiler's websocket client) and in the Vercel function runtime package, none of which
  runs in the browser or the contract; tracked for the next dependency pass.
- **Fixes named in the independent review are deployed**: contract code `8c1d2986…` on both
  networks, and the dapp and ceremony site at the commits after `65ee271`.

## Still to do before raising the caps

External audit of the contract, the circuit and the client library; the circuit change above;
in-wallet key derivation; the real ceremony followed by `setvk`.

## Shielded mode: internal review (2026-09-08)

Four reviewers worked Brief 5 in [04-review-briefs.md](04-review-briefs.md) against commit
`5faf19c` and later, one per area. Every finding below was reproduced against the code before
it was changed. The cryptography, the contract's accounting and the client's faithfulness to
the reference library held; the work was in one circuit bound, denial-of-service resistance,
custody on one wallet type, RPC trust and precise privacy wording.

| # | area | finding | fix |
|---|---|---|---|
| 1 | circuit, **critical** | The spending scalar `ask` was only bounded to 253 bits, not below the subgroup order L. Since `pk = ask·G` is a group multiplication, `ask + k·L` gives the same registered key and passes the contract's check, but `nk = Poseidon(ask, 0)` differs, so one note had up to five distinct nullifiers: its owner could spend it five times and drain the escrow. Reproduced on the revision-3 circuit by witness calculation: `ask + L` gave the same `senderPk` and a different `nf`. | `ask` is decomposed alias-free and compared against L − 1 in the circuit; a test spends with `ask + L` and is refused. Revision 4, new rehearsal key. |
| 2 | circuit, medium | The parity bit of the receiver key in the auditor ciphertext came from a `Num2Bits(254)` decomposition, which is not alias-free below 2^254 − p, so a prover could flip it and hand the auditor a note it cannot attribute. | Alias-free decomposition (`Num2Bits_strict`). |
| 3 | circuit, low | The same leaf could be spent twice in one proof (blocked by the contract's nullifier check only). | In-circuit: the second input's index must differ from the first. |
| 4 | circuit, low | Output keys only had to be on the curve; identity and low-order points were accepted (a burned note, an unattributable receiver). `register` accepted them too. | In-circuit: 8·outPk must not be the identity. Contract: `register` rejects the identity and low-order keys. |
| 5 | circuit, low | A zero ephemeral scalar would publish the sender's own plaintext. | In-circuit: esk ≠ 0. |
| 6 | contract, high | A full tree freezes every spend including withdrawals; every insertion takes a pair of slots and there was no minimum deposit. | Per-token minimum deposit (1 XPR, 1 XMD on testnet). The committee `restore` is added before mainnet; a withdraw-only path that inserts nothing is a possible later change. |
| 7 | contract, high | Deposits bill the contract's RAM (a notification cannot bill the sender), and the root ring stored before it evicted, so a full account froze spends too. | Ring evicts before it stores; minimum deposit bounds the cost; and, done the same day, the notification now records only a small credit row while the owner's own `deposit` action builds the note and pays for its rows. |
| 8 | contract, medium | 128 insertions between proving and inclusion evicted a proof's root; dust deposits could grief in-flight spends. | Ring of 1,024 roots; minimum deposit. |
| 9 | contract, low | The pool counter saturated on an over-withdrawal; unlisted tokens were absorbed silently; two messages said 33 inputs; a token id above 255 would be unspendable. | Over-withdrawal refused; unlisted tokens refused; messages fixed; token id bounded at `addtoken`. |
| 10 | client, high | The WebAuth popup session carries no public key, so the app treated it like a passkey wallet and, without any signature, kept a random key in browser storage with no way to recover it. | Every setup starts with a signature; a wallet that cannot promise determinism signs a second time and only if the two differ is a generated key kept, with its secret shown and copying required before registration; a saved key that matches the registration is still accepted. |
| 11 | client, medium | The recipient's key was taken from one node the app picked by that node's own claimed head, with no owner check; a lying node could redirect a payment. | The row's owner is checked, the key must agree between two nodes or the node and the cached key table, and a fingerprint of the key is shown beside the recipient. |
| 12 | client, medium | One malformed outputs row from a node blanked the whole balance. | Per-row guard; malformed rows are skipped and counted. |
| 13 | client, low | Sign-out left shielded state and a running refresh loop behind for the next account; the key-derivation signature bypassed the blocked-window detection; a pagination boundary repeat; a non-canonical zero from the JS square root. | All fixed. |
| 14 | privacy, high | The change note always went second, so position told an observer which new note was the sender's. | The app writes the two outputs in random order; the circuit and contract never cared. |
| 15 | privacy, high | The token id travelled on plain transfers, revealing XPR versus XMD for every payment. | Zero on a transfer, and the contract refuses a token id without a withdrawal. |
| 16 | privacy, medium | The recipient's name was sent to a node at send time and on each keystroke. | Names resolve locally from the whole key table. |
| 17 | privacy, medium | The threat model understated what initiators, input counts and leaf indices reveal, and section 5 of the design still described the relay model. | Sections 5 and 8.2 of the design rewritten. |

Accepted, with the reason: the `viewkey` action stays a no-op rather than an always-failing
action, because some wallets simulate before signing and would refuse to sign a failing
transaction, which would break key derivation for everyone; no wallet has been seen to
broadcast a request marked not to be broadcast. The nullifier table stays keyed by the low 64
bits: a targeted collision needs the victim's nullifier key, and an accidental one over a full
tree is about 2⁻²⁵.

## Shielded mode: independent review (Codex, 2026-09-08)

Worked Brief 5 after the internal round, against the fixed tree. Four findings, each
reproduced and fixed the same day; the dependency and secret-hygiene notes are recorded below.

| # | area | finding | fix |
|---|---|---|---|
| 1 | contract, high | `addtoken` accepted two symbols with the same token id; notes bind the id, and a withdrawal picks the first symbol with that id, so an operator mistake could pay the wrong asset. | The id must be unique across tokens; re-adding the same symbol still updates its caps. Test added. |
| 2 | client, medium | Switching accounts left the generated secret and the two-signature state behind, and a refresh started for the previous account could repopulate the next account's notes. | All account state, including the secret and the signature state, is cleared on switch; every asynchronous result is discarded unless the session counter still matches. |
| 3 | client, medium | A reload restored a saved key but not the "copy your secret first" gate, so a passkey user could register with no backup. | Backup status is persisted beside the key; until the secret has been copied once it is shown again, registration stays gated, and a registered account with an uncopied secret sees the warning on its statement. |
| 4 | client, medium | The main site's confirmation of incoming rows against the chain was cached by transaction id alone, so a later indexer row with a changed ciphertext inherited a "confirmed" verdict. | The cache key includes sender, receiver and the ciphertext. |

Also noted: dependency advisories in build and ceremony tooling (tracked, none in browser or
contract code; `path-to-regexp` and nested `undici` in the ceremony functions, `lodash.set` in
contract tooling, `tracing-subscriber` and `memmap2` in the benchmarks); the gitignored local
key files were world-readable on the developer machine and are now owner-only; the published
testnet relay key is gone from the contract's permissions, confirmed on two nodes. The known
release risks stand as stated in the design doc: rehearsal proving keys, browser storage for
fallback keys, and the tree's capacity, which the minimum deposit prices but does not remove.

## Shielded mode: third round, after recovery, /old and the activity timeline (2026-09-08, evening)

Three internal reviewers worked the code that changed after the second round: native math and
tree, actions and money flows, the client's recovery, scan and history. All findings fixed the
same day; contract redeployed to testnet (code `e42775fc…`), mainnet build re-hashed (docs/07).

| # | severity | finding | fix |
|---|---|---|---|
| 1 | medium | Deposit credits were contract-paid, unbounded and found by a linear scan: an attacker's `min_deposit` transfers with no second action would fill the contract's RAM (about 4,500 rows per 800 KB) and slow every honest deposit; the attacker's capital was only locked, not spent | One owner-paid deposit **slot** per registered account, created at `register` (or `open` for earlier accounts). The notification fills the empty slot with a same-size update, which bills nothing; `deposit` empties it; an occupied slot refuses the next transfer, so the table grows only with registrations and lookup is one get |
| 2 | low | `esk = L` (a multiple of the subgroup order) passes the circuit's `esk != 0` check; `epk` is the identity and both ciphertexts are readable by anyone. A malicious sender can publish a payment; the receiver can still spend it | `spend` refuses an ephemeral key that is the identity or has low order (`inPrimeSubgroup` after decompression). Circuit revision 5, when there is one, bounds `esk` below L like `ask` |
| 3 | low | `init` and `setauditor` accepted a low-order auditor key (operator error that would make every note public) | subgroup check on the auditor key in both |
| 4 | low | `register` accepted a key already registered by another account (a sender looking up the second name pays the first; the auditor's key-to-name mapping becomes ambiguous) | `register` refuses a key any other row holds |
| 5 | low | A withdrawal (or `restore`) to an account with no balance row for the token made the token contract bill the new row to xprshield | the contract refuses unless the row exists; the app adds the token's `open` to the withdrawal transaction when it is missing |
| 6 | **high** (client) | The committee copy was sealed to whatever auditor key one node reported, and the Auditor tab accepted such a key: a lying node turns "committee copy" into a copy for itself | the committee key is **pinned per network in the build** and the config row must be agreed by two nodes and equal the pin; otherwise the app refuses to seal or to open the auditor page |
| 7 | **high** (client) | A lying node could show any balance and any "received" note: scan trusted one node's tables and never checked the root | the tree row (root, next_leaf) must be agreed by two nodes; the leaves are rebuilt (cached, append-only) and must hash to that root; only outputs inside the agreed tree count; a single-node answer shows the balance as unconfirmed |
| 8 | medium (client) | Payer names, withdrawals and the sent arithmetic followed an unverified Hyperion record; forged records named a wrong payer, showed a fake withdrawal, and overrode the payer in the Auditor tab | every record that touches the account's notes is verified against a chain node's block (transaction id, this contract's `spend`, owner authorised, publics equal) and its fields are taken from the block; records are unique by transaction and by nullifier, and only count when the nullifier is spent and the outputs are leaves on chain; verified records are cached per transaction |
| 9 | medium (client) | A node that hid the `backups` row made the client wipe the other recovery copy when saving one | the contract keeps a copy when the argument is empty (`clearbackup` removes explicitly) and the client never sends the other copy |
| 10 | low (client) | "Forget key" left a set-aside key and the sends memory in storage | forget removes everything under the account's prefix |
| 11 | low (client) | A standard-key wallet whose derived key did not match the registration had no restore path; a failed registration lookup showed as "not registered" | the restore screen also opens on a derived-key mismatch; a lookup that fewer than two nodes confirm shows "cannot confirm" with a retry, never the registration flow |

Also from this round: `inPrimeSubgroup` checks "not low order" (8·P ≠ O), which is what the
contract needs since every honest key lies in the prime subgroup; documented, not changed. The
signed derivation text `SHIELD_NOTE` says "(testnet)" and is part of the digest; it is frozen
as-is (changing it would change every derived key). The reviewers' reproductions are in the
session scratchpad and their tree/ring test is kept as `tests/tree-ring.test.mjs`; the differential
fuzz (`tests/fuzz.test.mjs`) and the bit-flip fuzz in the main suite were added the same evening.

## Shielded mode: independent review, second pass (Codex, 2026-09-08, late)

Run against the tree before the third internal round was pushed; two of its findings were fixed
by that round, two are new and fixed here.

| # | severity | finding | fix |
|---|---|---|---|
| 1 | high | `restore` paid from escrow without invalidating the refunded notes: a key recovered later could spend them and leave the pool short (confirmed with a real proof in vert) | `restore` marks the account in a `restored` table and `spend` refuses a marked owner (every spend is signed, so the notes need not be cancelled); the committee lifts the mark with `unrestore` once the escrow is whole. Tested: the account's proof is refused until `unrestore`, then accepted |
| 2 | high | committee copies sealed to an auditor key from one RPC server | fixed in the third internal round: the key is pinned per network and must be agreed by two nodes |
| 3 | medium | the phrase-replacement copy said the old phrase "stops working"; copies in chain history still open with it and the key does not change | the wording now says exactly that, and what to do if the old phrase may have leaked |
| 4 | medium | `build-mainnet.sh` did not create `deploy/mainnet/` on a clean checkout | `mkdir -p` |

## Shielded mode: independent review, third pass (Codex, 2026-09-08, at `a6c47f4`)

Three medium findings in the client, all reproduced with mocked responses; fixed the same night.

| # | severity | finding | fix |
|---|---|---|---|
| 1 | medium | a "confirmed" balance still took spent status from one node: missing nullifier rows made spent notes look available | nullifiers are read from every node and a note is spent if any node lists its nullifier (a node cannot invent one it has not seen on chain); the balance is confirmed only when two nodes answered |
| 2 | medium | the tree cache handed out its live object: a background scan could extend it under a prepared payment, changing the root while the action still named the old root sequence, so the proof was rejected | `chainTree` returns a snapshot; the live cache grows on its own |
| 3 | medium | history verification cached and deduplicated by transaction id, so a second spend in the same transaction returned the first action's data or vanished | identity is the transaction plus the action's first nullifier, which the chain allows exactly once |

## Shielded mode: independent review, fourth pass (Codex, 2026-09-08, at `af6bdbb`)

Two medium findings in the client's balance reporting, fixed together with the privacy and
resource pass below.

| # | severity | finding | fix |
|---|---|---|---|
| 1 | medium | spent status counted answering nodes, not agreement: one node listing a nullifier the others did not still produced a "confirmed" balance | a nullifier is spent when two nodes list it; one that a single node lists while another omits is disputed: treated as spent for safety and the balance shown unconfirmed until the nodes agree |
| 2 | medium | the scan checked that outputs had leaves but not that every leaf had its output, so an omitted output row passed the root check and silently hid a note | the outputs rows now carry the commitments and are the leaves: the tree is rebuilt from them, so an omitted or altered row changes the root and the node is refused |

Dependency advisories (8 dapp, 7 contract tooling, 19 circuits, none a demonstrated application
vulnerability) are tracked separately; `lodash.set` is a transitive dependency of the tooling.

## Privacy and resource pass (2026-09-08, night)

Assessment in the session record; changes made:

- **Circuit revision 5** (31,659 constraints, same 27 public signals): a disabled second input
  emits a dummy nullifier `Poseidon(nk, 2^40 + dummy)` with a fresh private `dummy < 2^40`, so the
  chain no longer shows whether a payment spent one note or two (real leaf indices are below
  2^20); the ephemeral scalars are bound below the subgroup order like `ask`. New rehearsal key;
  the ceremony's phase 2 will be run on this revision. Testnet reset and re-initialised with it.
- **Contract:** the `leaves` table is gone; the outputs rows carry the commitment. One row less
  per leaf (about 20% of a payment's RAM) and one table read less per scan, and it makes the
  outputs self-verifying against the root (finding 2 above). Both nullifiers are now always
  present, so `spend` requires two non-zero words.
- **Client:** no read names the account (recovery row, deposit slot and deposit history are
  whole-table or contract-wide reads matched locally); the tree is rebuilt from outputs.
- **Poseidon:** measured at 155 µs per hash in the local VM, about 300 ns per field
  multiplication, which is near the floor for 32-bit limbs in wasm; not changed.

## Shielded mode: independent review, fifth pass (Codex, 2026-09-08, at `3a8791b`)

Two medium findings in the client, fixed the same night.

| # | severity | finding | fix |
|---|---|---|---|
| 1 | medium | the root authenticates commitments but not the note data beside them: a node returning an altered ciphertext with the true commitment made the note vanish with a confirmed balance | outputs are read from every node; a row two nodes return identically is agreed, a disputed row has every variant tried (a note is only accepted if it recomputes to its authenticated commitment), and any dispute or single-node answer leaves the balance unconfirmed |
| 2 | medium | contract-wide deposit history was keyed by the random value alone, so another owner's equal value could overwrite the transaction and time | keyed by owner and value; the match stays local |

## Shielded mode: independent review, sixth pass (Codex, 2026-09-08, at `2e2fecf`)

| # | severity | finding | fix |
|---|---|---|---|
| 1 | medium | the new merge processed every node's outputs together, so one node's duplicate row or wrong commitment aborted a scan two healthy nodes could complete | each node's answer is validated on its own (unique indices inside the agreed tree, well-formed words, commitments hashing to the agreed root) and a failing answer is dropped before the payload variants are merged |

## Shielded mode: independent review, seventh pass (Codex, 2026-09-08, at `0c07516`)

No actionable findings. Verified: eighteen malformed-output cases across all three node
positions; two healthy nodes keep a confirmed balance; a single valid source gives an
unconfirmed balance and no valid source fails cleanly; the earlier payload, duplicate-counting
and deposit-history checks; production build and the security regressions. This closes the
review series before the ceremony's second phase: three internal rounds, seven Codex passes,
every finding fixed and tested.

## Shielded mode: independent review, eighth pass (Codex, broader, 2026-09-08, at `42c363f`)

| # | severity | finding | fix |
|---|---|---|---|
| 1 | high | token metadata came from one node: a node relabelling XMD with XPR's id and precision turned "1 XMD" into a note of 100 XPR, accepted with a real proof | the token table's identity (symbol, issuing contract, id) must be agreed by two nodes and must equal the ids and precisions this build was made with, else the app refuses; same in the headless client |
| 2 | medium | a wallet answer arriving after the account changed installed the previous account's key | unlock and phrase restore capture the session generation before the await and drop a late answer |
| 3 | medium | the tree agreement compared root and leaf count but not the root sequence, so a confirmed tree could carry a wrong sequence and a payment then fail | the sequence is part of the agreed tuple and every tree row is bounds-checked |
| 4 | medium | a malformed nullifier in one node's answer aborted the whole scan | nullifiers are validated inside each node's answer; a bad answer is dropped |

Launch items from the same pass, now in docs/07: the final revision-5 key ships under a fresh
file name (the circuit directory is cached immutably), the auditor key is pinned and committee
permissions verified before deposits open, tree capacity (1,048,576 leaves) is shown on the
Auditor tab and a successor-contract procedure is rehearsed before half capacity.

## Shielded mode: independent review, ninth pass (Codex, 2026-09-08, at `8c3986e`, including the headless client)

| # | severity | finding | fix |
|---|---|---|---|
| 1 | medium | the client signed even when selecting the chain in the proton CLI failed, and the CLI's chain setting is shared between processes | selection failure aborts; the selection is read back and must name the expected chain before signing; a lock under the key directory serialises the client's own invocations |
| 2 | medium | recovery phrases were taken from the command line, so they showed in process listings and shell history | phrases come from a hidden terminal prompt, or standard input when not a terminal; an argument is refused |
| 3 | medium | the client always put the receiver's note first and the change second, which the app randomises | the client shuffles the two outputs before building the witness |
| 4 | medium | malformed token or tree rows from one node could abort a read two healthy nodes agreed on, in both clients | those rows are validated inside each node's answer; a bad answer is dropped |
| 5 | medium | the Auditor tab measured capacity by output rows; a deposit stores one row but takes two tree slots | capacity is the agreed `next_leaf` against 1,048,576 slots |

## Shielded mode: independent review, tenth pass (Codex, 2026-09-08, at `0216114`)

| # | severity | finding | fix |
|---|---|---|---|
| 1 | medium | the client's signing lock lived under the key directory, so two key directories on one user had two locks while the proton CLI's chain setting stayed shared | the lock lives with the user (`~/.privatexpr-signing.lock`), one per user regardless of key directory |
| 2 | medium | a killed client left its lock behind and later invocations refused to sign | the holder records its pid; a lock whose holder is gone, or older than two minutes, is reclaimed (tested with a planted dead-owner lock) |
| 3 | low | the client README still showed recovery words as command arguments | the README shows the hidden prompt and explains why |

## Shielded mode: independent review, eleventh pass (Codex, 2026-09-08, at `20de90f`)

| # | severity | finding | fix |
|---|---|---|---|
| 1 | medium | stale-lock recovery could remove a live signer's lock: by age alone after two minutes, and immediately when the pid file was not yet written | the lock is a file created atomically with the holder's pid as its content, so it never exists without an owner; recovery is ownership-based only (owner not running), never by age; an empty or unreadable lock is left for ten seconds first; reclaiming renames before removing so two waiters cannot both take it; release checks the pid is its own. Tested: a lock held by a live process with an old timestamp made the client wait until that process ended; a dead owner's lock was reclaimed at once |

## Shielded mode: independent review, twelfth pass (Codex, 2026-09-08, at `76f5fd0`)

| # | severity | finding | fix |
|---|---|---|---|
| 1 | medium | two waiters could both see the same dead owner; the slower one's unconditional rename then removed the faster one's fresh lock | reclaiming renames the lock aside and checks that what was renamed is exactly the dead lock inspected (same inode); a fresh lock renamed by mistake is linked back; and, independent of recovery, every holder re-reads the lock immediately before signing and must find its own pid there, else it re-acquires and starts over. Tested with three concurrent signers |
| 2 | medium | locks in the previous directory format were never reclaimed, even with a dead owner, so signing timed out after an upgrade | the old format (a directory with a pid file) is recognised and reclaimed by the same ownership rule; tested |

## Shielded mode: independent review, thirteenth pass (Codex, 2026-09-08, at `24e64c7`)

| # | severity | finding | fix |
|---|---|---|---|
| 1 | medium | a signer displaced by lock recovery still reset the proton CLI's chain to mainnet in its cleanup while another signer owned the lock; a testnet action reached signing with mainnet selected | the file lock and its recovery are gone. The select-sign-restore sequence now runs under an OS-managed exclusive lock (`flock` on `~/.privatexpr-signing.lock`, held by a small python3 or perl helper for the duration). Two signers cannot interleave, a signer that dies releases the lock with its process, nothing is ever reclaimed, and there is no displaced process to touch the shared setting. A directory left by the earlier format is removed once. Tested: three concurrent signers, a live holder waited for, a holder killed with -9 released by the OS |

## Shielded mode: independent review, fourteenth pass (Codex, 2026-09-08, at `08fc912`)

| # | severity | finding | fix |
|---|---|---|---|
| 1 | medium | the one-time removal of the earlier directory-format lock could, in a race, remove another client's fresh lock file at the same path | the lock moved to a new path (`~/.privatexpr-signing.flock`) that was never a directory; nothing from earlier versions is touched |
| 2 | medium | if the lock-holding helper died after acquisition, the parent went on signing and restoring the chain without the lock | the helper now performs the whole select-sign-restore sequence itself while holding the lock, so the lock and the operation share one lifetime: if the helper dies no further step starts, and the parent only reads its result. python3 preferred, perl fallback, both tested |

## Shielded mode: independent review, fifteenth pass (Codex, 2026-09-08, at `fbf7208`)

| # | severity | finding | fix |
|---|---|---|---|
| 1 | high | the perl fallback built a shell command with action data in single quotes; chain- or node-supplied data with an apostrophe broke the quoting, and crafted data could have run commands locally | the perl fallback is removed; the python3 helper runs every proton call as an argument array, never a shell |
| 2 | medium | perl's END block restored the chain even after the lock acquisition had timed out | gone with the fallback; the python helper restores only inside the section it entered after taking the lock |
| 3 | medium | a proton child could outlive the helper's lock if the helper was killed mid-action | the locked descriptor is passed to every proton child, so the lock is inherited and lasts as long as the last process of the sequence. Tested: a helper killed with -9 while its child ran left the lock held until the child exited |

## Shielded mode: independent review, sixteenth pass (Codex, 2026-09-08, at `ccb2b6e`)

No actionable findings. Confirmed: transaction data stays out of shell commands; a timed-out
waiter cannot change the network; a proton child keeps the lock after its helper is terminated;
three concurrent signers stay exclusive through cleanup; a missing python3 and a failed network
check stop signing safely; the security regressions pass. This closes the review series for the
headless client as well: three internal rounds and sixteen Codex passes across contract, circuit,
app and client, every finding fixed and tested.

## Capacity: tree rollover (2026-09-09, before the first mainnet deploy)

Codex's standing priority, continued withdrawals at tree capacity, is closed by construction:
the contract keeps several trees and opens a fresh one when the active tree is full (or on the
committee's `newtree`), leaf indices are global (tree · 2^20 + position) so nullifiers never
collide across trees, and the circuit (revision 6) takes the tree as a public input that the
contract binds to the root it looked up, with both inputs of a payment in that tree. The vert
suite exercises a rollover end to end; the app and the client rebuild and verify every tree and
pick a payment's notes within one. A full tree can no longer block anyone's exit.

### Internal review of the rollover (2026-09-09, at `d419d69`)

| # | Where, severity | Finding | Fix |
|---|---|---|---|
| 1 | contract, **critical** | The root ring evicted by global sequence regardless of tree, so a closed tree's final root fell out of the ring 1,024 insertions after the rollover. A closed tree receives no more leaves, so that root is the only one its notes can be proved against: every unspent note of a closed tree became unspendable, transfers and withdrawals alike. The claim above did not hold. | `rememberRoot` never evicts a row that is a closed tree's final root (the row's sequence equals that tree's `root_seq`); the ring holds 1,024 rows plus one per closed tree. Regression `tests/rollover-ring.test.mjs`: 1,029 insertions after tree 0 closed, its unspent note still spends by the tree row's sequence, and the ring holds exactly 1,025 rows. |
| 2 | contract, low | `newtree` opened a new tree even when the active one was empty, leaving empty closed trees behind. | Refused: "the active tree is empty; nothing to roll over". |
| 3 | comments | Stale counts (27 verifier words, dummy nullifier domain 2^40) in the contract, the note libraries and the app. | Corrected to 28 and 2^60. |

The regression runs in CI beside the main suite.

### Internal review of the rollover, app and clients (2026-09-09, at `440375e`)

| # | Where, severity | Finding | Fix |
|---|---|---|---|
| 1 | client, medium | The headless client's `rebuildAll` let a row with a fractional index through (a copy of a real row at n + 0.5 keeps the root), and `scan` then threw converting it to a BigInt: one lying node denied balance, send, withdraw and history, and `--force` could not help. The app already refused such rows. | The global index must be a non-negative integer before anything else; `scan` skips any other index as well. Regression `client/tests/lying-node.test.mjs` (live testnet); the app's `e2e/lying-node.mjs` now pads one node's outputs with the same row. |
| 2 | app and client, low | The "spans more than one tree" message appeared whenever notes sat in two trees and no tree paid with two notes, also when the balance was simply short or when one tree held the amount in three notes. | Total across trees checked first ("not enough"); then a tree holding the amount in more than two notes ("pay yourself the total first, two notes at a time"); only then the cross-tree message, which now says what to do. |
| 3 | demo CLI, low | `pick` tried only the richest tree. | Every tree is tried, as in the client. |
| 4 | app, low (predates the rollover) | A lying node's outputs were written into the tree cache before the root check, and the cache was deleted on a mismatch, so one lying node forced a full rebuild (two million hashes for a full tree) on every scan. | Each node's outputs are built into a candidate copy and only replace the cache once the root matched; a verified cache is never discarded because another node failed. |
| 5 | app, nit | The auditor page said "tree 1 of 2 in use" for the second tree (0-based id beside a count). | 1-based. |

Found sound: tree-row agreement (row set plus active tree as the key), output filtering per tree, proof binding of the tree word, per-tree root sequence carried into the proof, note picking within one tree, and activity and auditor paths ordered by the global index.

## Shielded mode: independent review, seventeenth pass (Codex, 2026-09-09, at `7e6d944`)

Codex reviewed the rollover series (`35341a0` to `7e6d944`): the fund-locking fix and the client crash fix hold; no fund-loss or decryption issue reproduced; contract suite, fuzz, rollover regression, security regressions and both builds pass with hashes matching the runbook. Three items, all fixed:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | medium | The client regression combined two-node agreed roots with the outputs of the first responding node, so a lagging testnet node failed CI while production scanning succeeded. | The test builds both trees and the outputs table locally with the note library and never touches a node; it also covers a duplicate position and a swapped commitment. |
| 2 | low | The browser regression compared "?" with "?" when the balance could not be read. | The baseline must be a numeric non-zero balance and the honest history rows must be present, else the run fails. |
| 3 | low | The runbook's dapp step still named revision-5 proving artifacts. | Revision 6, with the client's `REV` set to the same suffix. |

Outstanding as before: transitive dependency advisories in the ceremony web app.

