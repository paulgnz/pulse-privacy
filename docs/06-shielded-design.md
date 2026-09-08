# 06 — Shielded transfers: hiding who pays whom (design, 2026-09-08)

Decision: build a second contract, `xprshield`, in which a payment shows neither the sender nor
the receiver on chain, test it on testnet, and keep the current `xprconf` untouched. The auditor
keeps full visibility, so this is still confidential-with-compliance, not anonymity from
everyone. This page is the design; the milestones are at the end.

> **Revision 2 (2026-09-08, after S5).** The relay model in §0–§3 was built and tested, then
> replaced: the sender's wallet signs every spend and only the receiver, the amount and the
> spent notes are hidden. The reasons, the changes and the merge into `xprconf` are in **§8**,
> which supersedes the relay parts of the sections above. Milestones S7 onward are the plan.

## 0. One page

Today (`xprconf`) a payment is an account-to-account row: *paul paid alvosec, amount hidden*.
The receiver's name is in the action because the contract adds the payment into the receiver's
box. To hide the names the contract must stop keeping per-account boxes and keep a pile of
sealed **notes** instead, the way Zcash does:

- A note is a sealed envelope: "*v* units of *token*, spendable by public key *pk*", plus two
  random values. Only its hash, the **commitment**, goes on chain, into an append-only Merkle
  tree that the contract maintains.
- To pay, you prove in zero knowledge: "I hold notes in the tree worth at least *v*; here are
  their **nullifiers** (one-way tags that prevent spending twice); here are new commitments for
  the receiver's note and my change note; the values balance." The chain sees the proof, two
  nullifiers, two commitments and encrypted payloads. It cannot tell which notes were spent,
  who spent them, or who received.
- Nobody's wallet signs the payment. A relay permission on the contract, whose key is public,
  submits it. The transaction shows `xprshield@relay`. No wallet prompt for sending or
  withdrawing; only deposits are wallet transfers.
- Every note is also encrypted to the auditor's key, and the proof enforces it. The auditor
  reads sender key, receiver key, amount and token for every payment, and maps keys to account
  names through the registration table. Balances reconstruct by summing. Same compliance model
  as today, same viewing key.

What stays public: deposits and withdrawals, their amounts, and their timing. Everything inside
is a set of sealed notes moving between keys. The crowd you hide in is everyone using the pool.

## 1. ELI5

Today the contract is a row of locked post-office boxes with names on them. When paul pays
alvosec, the postman carries a sealed envelope from paul's box to alvosec's box, and anyone
watching sees the names on both boxes. The amount inside is sealed, the names are not.

The new contract is a single big bin with no names. Paying means dropping two new sealed
envelopes into the bin (one for the receiver, one with your change) and handing the postman two
torn-off ticket stubs proving you had envelopes to spend, without saying which. The stubs cannot
be reused, so you cannot spend the same envelope twice. The postman is a public helper anyone
can use, so the drop does not carry your name either. The receiver walks past the bin later and
recognises their envelopes because only their key opens them. The auditor has a master key that
opens every envelope and reads the sender's and receiver's names written inside.

What a watcher sees: "someone dropped two envelopes and tore two stubs". What the auditor sees:
"paul paid alvosec 1,234 XPR".

## 2. Cryptography

Curve and field as today: Baby Jubjub over the bn254 scalar field; Groth16 on bn254 verified
with the chain's `alt_bn128_*` intrinsics. The hash everywhere is Poseidon (circomlib
parameters), because it costs about 240 constraints in the circuit and can be computed by the
contract.

### 2.1 Keys

| key | how | used for |
|---|---|---|
| spending key `ask` | derived from the wallet signature exactly as today (`viewkey` message), or a saved key for passkey wallets | proving ownership of notes |
| public key `pk = ask·G` | registered on chain under the account name | receiving notes; senders look it up by name |
| nullifier key `nk = Poseidon(ask, 0)` | derived | forming nullifiers |
| auditor key `A = a·G` | committee-held, in config | second keyhole on every note |

One key per account for v1. Splitting viewing from spending (a separate incoming-viewing key)
is a later refinement; the auditor already covers the compliance case.

### 2.2 Notes

A note is `(pk, v, token, rho, r)`: value `v < 2^64` in the token's base units, `token` a small
integer id (1 = XPR, 2 = XMD), `rho` and `r` random field elements. Its commitment is

    cm = Poseidon(pk.x, pk.y, v, token, rho, r)

Commitments live in a Merkle tree of depth 20 (a million notes) with Poseidon(2) at every node
and zero leaves defined as `Poseidon(0,0)` chains. The contract keeps the tree's frontier (one
node per level) and inserts by hashing up the path: 20 hashes per insertion. A transfer's two
outputs are inserted as a pair, so the tree is really a tree of pairs and one transfer costs
1 + 20 hashes.

The nullifier of a note at leaf index `i` is

    nf = Poseidon(nk, i)

Using the leaf index rather than `rho` means no two notes ever share a nullifier, so nobody can
brick a note by sending a duplicate. A dummy input (when you spend only one note) has `nf = 0`,
which the contract does not record.

### 2.3 The join-split statement (two in, two out)

Private: `ask`; for each input `i ∈ {1,2}`: note fields, leaf index, Merkle path, `enabled_i`;
for each output `j ∈ {1,2}`: note fields and an ephemeral secret `esk_j`.

Public: `root`, `nf_1`, `nf_2`, `cm_1`, `cm_2`, `epk_1`, `epk_2` (Baby Jubjub points),
receiver ciphertexts `C^r_1, C^r_2` (4 field elements each), auditor ciphertexts `C^a_1, C^a_2`
(8 each), `v_pub`, `token_pub`, `to` (account name as a 64-bit field element), auditor key `A`.

The proof shows:

1. `pk = ask·G` and `nk = Poseidon(ask, 0)`.
2. For each enabled input: its note has owner `pk`; `cm_i` recomputes; `cm_i` sits at leaf
   `idx_i` under `root` (20 Poseidon(2) steps); `nf_i = Poseidon(nk, idx_i)`. For a disabled
   input: `v_i = 0` and `nf_i = 0`.
3. Both inputs and both outputs carry the same `token`; `v_pub·(token_pub − token) = 0`.
4. `v_1 + v_2 = v'_1 + v'_2 + v_pub`, every value range-checked to 64 bits.
5. Output commitments recompute from the output notes.
6. Encryption: `epk_j = esk_j·G`; `k^r = Poseidon((esk_j·pk'_j).x, (esk_j·pk'_j).y)` and
   `C^r_j[m] = plaintext_m + Poseidon(k^r, m)` for `(v', token, rho', r')`; likewise
   `k^a` from `esk_j·A` and `C^a_j` over `(pk'.x, pk'.y, v', token, rho', r', pk.x, pk.y)`.
   The auditor ciphertext carries the sender's key, so "who paid whom" is bound by the proof.

`to` is bound so a relayer cannot redirect a withdrawal; it is zero for a transfer. Measured
(S2): **31,418 constraints** after circom's linear simplification, under the current circuit's
46,874 and inside the 2^16 Powers of Tau already contributed to, so phase 1 of the ceremony is
reused and only a phase 2 is needed. Proving takes about 1.4 s in Node; a browser should be
similar.

### 2.4 Withdraw

The same circuit with `v_pub > 0`, `token_pub` set and `to` set. The contract pays `v_pub` of
the token from escrow to `to`. A withdrawal spends notes and creates change, so it looks like a
transfer plus a public payout: the chain learns that *someone* withdrew 1,000 XPR to alvosec.

### 2.5 Deposit

A token transfer to the contract with memo `shield:<rho>:<r>` (two 32-hex-character values).
The contract looks up the depositor's registered `pk`, computes `cm` itself (one Poseidon(6)),
and appends it. The note's contents are therefore public, which is fine: the deposit is public
anyway, and knowing `rho` and `r` does not let anyone spend or nullify the note. The depositor's
client rebuilds its deposit notes from its own transfer history, so nothing needs saving.

## 3. Contract (`contracts/xpr-shield-tsc/`, proton-tsc)

### 3.1 Field arithmetic

`xprconf` multiplies field elements through the `mod_exp` intrinsic (three calls per product),
which costs a few hundred microseconds per point addition. A Poseidon(2) is about 600
multiplications and a transfer needs 21 of them, so that route would cost seconds. The new
contract carries its own Montgomery multiplication over the bn254 scalar field in
AssemblyScript (8 × 32-bit limbs, CIOS), which should land near half a microsecond per product
under EOS VM's JIT. Budget: about 0.5 ms per Poseidon(2), 10 to 15 ms per transfer for the tree,
plus 3 to 4 ms for the Groth16 verify with 35 public inputs. Measured (S1, 2026-09-08, testnet
account `xprshield`, bench contract `shbench`): the AssemblyScript Poseidon matches circomlibjs
bit for bit for two and six inputs; **one Poseidon(2) costs 380 to 600 µs of billed CPU** on the
testnet producers (about 150 µs in V8, so the chain's runtime is 2.5 to 4× slower than a
browser), a Poseidon(6) 1.4 ms, and **a full pair insertion (21 hashes) 7.8 to 8.2 ms**. So a
transfer lands near 12 to 14 ms of CPU (tree plus verify), under the chain's 150 ms
transaction limit with room to spare, and comparable to today's 7.8 ms `send`. Fallbacks if it
ever matters: Poseidon2 (about 2.5× fewer multiplications), a depth-16 tree, or batching
insertions into a separate `settle` action.

### 3.2 Tables

| table | key | content | RAM payer |
|---|---|---|---|
| `keys` | account | `pk`, recovery blobs as today | the account (`register`) |
| `leaves` | leaf index | `cm` | contract |
| `frontier` | singleton | next index, one filled node per level, current root | contract |
| `roots` | ring of 128 | recent roots, so a proof built a few seconds ago still verifies | contract |
| `nullifiers` | `nf` | present = spent | contract |
| `config` | singleton | auditor key, verifying key, paused, caps per token | contract |
| `pool` | token | escrow counters (deposits, withdrawals) | contract |

An `outputs` table keeps each output's ephemeral key and both ciphertexts (and, for deposits,
the plaintext note) so a receiver needs no history indexer, which testnet lacks. The contract
pays RAM for leaves, outputs and nullifiers (about 1.3 KB per transfer). On testnet that
is fine. On mainnet a spender could split their own notes to burn the contract's RAM; the
mitigation is a small per-transfer fee taken inside the circuit (a public `fee` term in the
balance equation credited to the contract) or a rate-limited relay. Decided at the mainnet
step, not now.

### 3.3 Actions

| action | auth | what |
|---|---|---|
| `register(account, pk)` | account | as today; identity and low-order keys refused |
| `deposit(owner, r)` | owner | places an arrived deposit as a note; owner pays the rows |
| `restore(to, quantity, memo)` | contract, paused only | committee recovery, paid from escrow |
| `transfer(proof, publics)` | none checked; submitted by `xprshield@relay` or anyone | verify proof; `root` must be in `roots`; each non-zero `nf` must be new, then stored; append `cm_1`, `cm_2` as a pair; update root; if `v_pub > 0` pay `to` and count the withdrawal; emit nothing else |
| on `transfer` notification | token contract | memo `shield:r`; caps and minimum; records a credit for the owner's `deposit` |
| `setvk`, `setauditor`, `pause`, `setcaps`, `setpool`, `restore` | contract | as today |

The relay: a permission `relay` on the contract account whose private key is published in the
README, linked with `linkauth` to `transfer` only. Anyone can sign with it; nobody's own account
appears. It spends the contract account's CPU and NET, so mainnet needs either staked resources
sized for the traffic or a hosted relay with rate limiting. The dapp signs with the relay key in
the browser and never opens the wallet for a send or a withdrawal.

Concurrency: proofs are built against a recent root; because the ring keeps the last 128 roots,
two people paying in the same second do not invalidate each other.

## 4. Client and auditor

**Finding your notes.** The client reads every `transfer` action (Hyperion, with the block-level
chain fallback used today), computes the shared secret from each `epk` with its own `ask`,
trial-decrypts, and keeps the ciphertexts whose decryption recomputes the on-chain `cm`. Spent
status: compute each note's `nf` and look it up in `nullifiers`. Deposits are read from the
account's own transfers. Balance = sum of unspent notes. At today's volume this is milliseconds.

**Merkle paths.** The client fetches `leaves` and builds the tree locally with the same Poseidon;
a million leaves is too many for a browser, so the client caches subtrees, which is a later
optimisation. Under ten thousand notes it is a second of work.

**Spending.** Pick up to two unspent notes covering the amount (largest first); if more are
needed, a consolidation transfer to yourself runs first, like today's fold. Build the proof, sign
with the relay key, broadcast, mark the notes spent. No wallet interaction.

**Auditor.** The auditor CLI decrypts `C^a` in every transfer with the viewing key, reads sender
and receiver keys, amount, token, maps keys to names through `keys`, reconstructs balances by
summation, and reconciles escrow against deposits and withdrawals, as today.

## 5. What it does and does not hide

Restated after the review of 2026-09-08 (§8.7), for the signed-sender model of §8.

- Hidden: the receiver and the amount of every payment inside the pool; which notes were
  spent; whether a given new note is the payment or the change (the app writes the two in
  random order).
- Visible: who initiated each spend, and when; whether it spent one note or two; whether it
  was a withdrawal, and then the amount, token and destination; who deposited how much and
  when; the size of the pool; the set of accounts that have registered a key. The token of a
  plain transfer is not visible.
- Inference: with few users, "someone in the pool paid someone in the pool" narrows quickly.
  Because initiators are visible, an observer can list, for any spender who never deposited,
  the earlier initiators whose payments could have funded them; at low volume that list is
  short. A receiver who spends right after being paid links the two by timing. Deposit-then-
  withdraw of matching amounts at close times is linkable, as in every shielded pool. An
  observer who knows an account's only notes are its public deposits learns the sum of a
  one-input spend's outputs. None of this is solved; it is stated.
- The auditor sees everything, by design.
- Network level: the node that serves the app sees the IP that submitted a spend. The app
  resolves recipient names locally from the whole key table, so a recipient's name is not
  sent to a node on its own.

## 6. Relation to `xprconf`

`xprconf` stays as it is: it is simpler, cheaper per transfer, and its ledger is readable by
name. The shielded contract is a separate account with its own escrow, on testnet and on
mainnet (§8.4). Moving value between them is a public withdrawal and a deposit. They share the
registration idea, the key derivation, the auditor key, the dapp shell and the ceremony's
phase 1.

## 7. Milestones

| # | milestone | proves | done when |
|---|---|---|---|
| S0 | this design | the shape is agreed | page committed |
| S1 | Montgomery field multiplication and Poseidon in AssemblyScript, matching circomlibjs bit for bit; a bench action on testnet. **Done 2026-09-08**: `contracts/xpr-shield-tsc/` (`fr.ts`, `poseidon.ts`, `shbench.contract.ts`, conformance test), numbers in §3.1 | the on-chain hashing budget | measured CPU for Poseidon(2) and a 21-hash insertion, recorded here |
| S2 | join-split circuit, note library, tests, rehearsal setup on the existing 2^16 ptau. **Done 2026-09-08**: `circuits/shielded/joinsplit.circom` (**31,418 constraints** with `--O2`, 38 public signals), `circuits/lib/notes.mjs`, `test/joinsplit.test.mjs` (two-in two-out, dummy input, withdrawal, receiver and auditor decryption, six refusals, prove + verify, redirected withdrawal rejected); proof **≈ 1.4 s in Node**; rehearsal zkey `build/joinsplit_final.zkey` | the statement, constraint count, proving time | `npm run test:shielded` green |
| S3 | the contract with vert tests for every action, including double spend, stale root, wrong token, relayer redirect. **Done 2026-09-08**: `contracts/xpr-shield-tsc/assembly/xprshield.contract.ts` (78 KB WASM; tables config, tokens, keys, leaves, tree, roots, nullifiers; actions init, addtoken, setvk, setauditor, pause, viewkey, register, transfer, and the deposit notification), `tests/xprshield.test.mjs` under vert with real proofs: deposits match the library's tree, relay-submitted transfer, double spend, tampered publics, foreign auditor key, proof against a previous root accepted, redirected withdrawal refused, withdrawal paid, pause | the semantics | tests green |
| S4 | testnet deployment on a new account, relay permission, CLI demo: register, deposit, shielded transfer, withdraw; auditor CLI reads it back. **Done 2026-09-08** on testnet account `xprshield`: relay permission `xprshield@relay` with a published key linked to `transfer`; paul123 deposited 500 XPR (tx `cf1764d8…`, 8.7 ms), two shielded payments of 123.4 XPR to testclient1 submitted by the relay (tx `98f69751…`, **14.5 ms CPU**, no account named in the action), testclient1 withdrew 100 XPR to its public account, and `testnet-demo.mjs audit` lists every leaf as `paul123 → testclient1 1,234,000` from the auditor key alone. Receivers rebuild their notes from the `outputs`, `leaves` and `nullifiers` tables with no history indexer | end to end on a live chain | the explorer shows a transfer with no names and the auditor names both parties |
| S5 | dapp: shielded mode on the testnet site (statement from notes, send and withdraw without wallet prompts, activity from decrypted notes). **Done 2026-09-08**: `/shielded` on the testnet site (`dapp/src/components/Shielded.tsx`, `dapp/src/lib/shield/`): one wallet signature derives the shielded key (`xprshield::viewkey`, its own hash domain), one wallet transaction registers it, deposits are wallet transfers with the note in the memo; send and withdraw build the proof in the browser and submit through the relay key bundled in the app, so the wallet is never asked. Notes are rebuilt from the contract tables. Poseidon is a BigInt port checked against the published vector. A headless-browser run against testnet with the demo key scanned both parties and sent 1 XPR in 1.4 s end to end (tx `94e0303f…`) | usable by testers | testers send to each other |
| S6 | review briefs, phase-2 ceremony, `setvk`, then the mainnet decision | | |

Not in scope until S6: fee for RAM, split viewing keys, subtree caching, hosted relay.

## 8. Revision 2: signed sender, sealed receiver (decided 2026-09-08)

### 8.1 Why

The relay build (S1–S5) hid the sender by letting anyone submit the proof. That put the whole
authority to spend into the spending key, and the spending key lives in the browser. A copy
of that key, from a shared machine, an extension, or a backup, moves the funds. The current
product never has that property: nothing moves without the wallet. Paul's call: the wallet
signs every spend, the chain may see who initiated a transfer, and what must stay hidden is
who received it and how much.

What this gives up is sender anonymity. A watcher can count and time an account's transfers,
and if the receiver spends immediately after being paid, timing links the two. That limit is
stated to users, not solved.

What it gains: custody as today (wallet plus proof, two factors); no relay permission and no
published key; the sender pays their own CPU and RAM, which removes the spam concern; the
auditor still opens every note and the chain additionally shows the initiator, which suits the
committee's compliance model; mobile and passkey wallets behave as they do on the main site.

### 8.2 Threat model, restated

| party | sees |
|---|---|
| anyone | that account X spent notes and created notes at time T; deposits and withdrawals with amounts and names; the pool size |
| the receiver | their own notes, from trial decryption |
| the auditor | sender key, receiver key, amount and token of every note; names through the registration table |
| a thief with the browser's key but not the wallet | can read the account's notes; cannot spend them |
| a thief with the wallet but not the key | can sign but cannot build a proof; cannot spend, and cannot read |

What "anyone" sees per spend, precisely: the owner and permission, a 256-byte proof, 16 public
words, the amount (zero for a transfer), the token id (zero for a transfer), the root sequence
the proof named, the block time. The action is a constant 785 bytes. Whether one or two notes
were spent is visible (the second nullifier is zero for one). The root sequence bounds how
old the sender's view of the tree was.

### 8.3 Changes

**Circuit.** The sender's public key `pk = ask·G` becomes a public output (two words) and the
sender's account name a bound public input, alongside `to`. Public signals go from 38 to 41:

    nf[2] cm[2] epk[2][2] cr[2][2] ca[2][3] senderPk[2] | root vPub tokenPub to sender A[2]

A new phase-2 setup on the same 2^16 phase 1. Everything else in §2.3 stands, with the
revision-3 encoding below.

**Revision 3 (same day, before review): the encoding.** No `rho` (nullifiers already use
the leaf index), so a note is `(pk, v, token, r)` and `cm = Poseidon(pk.x, pk.y, v, token, r)`;
value and token pack into one word; the receiver ciphertext is two words and the auditor's
three, the receiver key travelling as `(y, parity of x)` with the parity at bit 72 of the packed
word; ephemeral keys travel compressed the same way and the contract decompresses them (a
square root in the field, about 1 ms); the amount, the token id and the root's sequence number
are native action fields, the contract supplies the root bytes from its ring. Circuit: 28,477
constraints, 27 public signals. **The action carries 785 bytes** (256 proof, 512 public words,
17 native), down from 1,152. Measured on testnet: spend 15.0 ms, withdrawal 15.3 ms.

**Contract.** `spend(owner, proof, publics, amount, token_id, root_seq)` calls `require_auth(owner)`, checks that the
`senderPk` in the proof equals `keys[sender]`, and stores leaves, outputs and nullifiers with
`sender` as the RAM payer. Withdrawals pay `to` only when `to == sender` (own account only,
decided). The relay permission and the public key are removed; there is no unauthenticated
path. `outputs` stays, so receivers still need no history indexer.

**Dapp.** Send and withdraw go through the wallet again, one signature each, as the main
site does. The derived key is a viewing-and-proving key: memory only for wallets that can
re-derive it; a saved copy for passkey wallets, which is now read-only exposure. The relay
key leaves the bundle. The setup copy changes to "your wallet signs every payment; the chain
sees that you paid, not whom or how much".

**Receiving.** Registered accounts only, as today: the sender looks the receiver's key up by
name, and the auditor maps keys back to names.

**Testnet.** `xprshield` is redeployed with the new contract and proving key; the tables are
reset (testnet-only `reset` action).

### 8.4 Two contracts, one product (decided 2026-09-08, replacing the merge plan)

The shielded contract launches on its own mainnet account, `xprshield`, and is not folded into
`xprconf`. The reasons, in order:

- **Blast radius.** `xprconf` holds users' money and has been through two reviews; the shielded
  code is new. In one contract they would share an escrow, so a shielded bug could reach
  deposits made by people who never used shielded mode. Separate accounts confine a bug to the
  contract it lives in.
- **Operations.** The shielded contract can be paused, upgraded or retired without touching the
  one people rely on, and the committee reviews and hashes one new contract rather than a merge.
- **Nothing is saved by merging.** The circuits, proving keys and ceremonies are separate either
  way.

What the merge would have given, one product for the user, lives in the app instead: the same
wallet signature derives both keys (different hash domains); one "Shielded" tab beside the
statement; the auditor page and CLI read both ledgers; the same auditor public key is set on
both contracts; the app bundles the shielded registration with the first shielded deposit so
the extra account is invisible. Cross-references: `xprconf` and `xprshield` share the design
of registration, the key derivation, the auditor key and the ceremony's phase 1.

Done before mainnet (2026-09-08): a paused-only committee `restore` that pays from escrow
with a memo and marks the account so it cannot spend until the committee's `unrestore` (its
notes cannot be cancelled, but its spends are signed, so the mark closes the double claim); `reset` compiled in only when the `TESTNET` flag is true; and the
owner-paid deposit: the token transfer's notification only records a small credit row, and
the owner's own `deposit(owner, r)` action, normally the second action of the same
transaction, builds the note and pays for its rows. An unfinished deposit can be finished
any time; the app offers it. Still to do at deployment: the account created and owned by the
committee (`admin.proton@committee`) with deployment permitted, about 800 KB of RAM, a
resource plan for the contract account (a code upload needs more NET than the free quota;
plans are per account and bought with `resources::buyplan`), both tokens with conservative
caps and minimum deposits.

### 8.5 Shielded replaces confidential (decided 2026-09-08)

Shielded is the product; `xprconf` retires once shielded has reached feature parity and
mainnet. The reasons: shielded hides strictly more (the receiver as well as the amount) at the
same auditability, the cost difference is small (about 15 ms of CPU per payment), and two
products with two key models and two Settings pages were confusing to build, to review and to
use. "Why not upgrade `xprconf` in place" was answered in 8.4: the balance model (one ElGamal
box per account) and the note model share nothing, existing encrypted balances cannot be
migrated by anyone but their owners, and deployed tables cannot change shape. A new contract
was the only clean path; what looked like mess was two products coexisting during the
transition. The transition is kept short and tidy by three rules:

1. **One site per network.** Wherever the shielded contract is enabled, shielded is the site:
   the statement at `/`, How it works at `/about`. The confidential contract becomes "the old
   contract" at `/old`, withdraw-only: no send, no deposit, no onboarding for accounts with
   nothing in it, a notice pointing to shielded, and a header link "Old confidential balance"
   shown only to accounts that still hold something there. Auditor and Settings for the old
   contract stay reachable so the committee can read it and a user can restore a key to
   withdraw. Done on testnet 2026-09-08; mainnet follows the same switch once `xprshield` is
   live there. The separate shield site tried on 2026-09-08 was retired the same day: a saved
   key is bound to the browser *and the site origin*, so a second origin only creates a second
   place to lose it.
2. **Parity before mainnet.** Recovery (seven-word phrase, committee copy, key file; built
   2026-09-08 with the `backups` table and `setbackup`), the onboarding steps with a progress
   bar, Activity, Auditor and Settings tabs, the auditor CLI, caps, pause and the runbook.
3. **Retirement path for `xprconf`.** After shielded mainnet: pause deposits (the `paused`
   flag already refuses them), keep withdrawals and the auditor working indefinitely so nobody
   is ever locked in, move confidential off the first screen, and after a quiet period hand the
   remaining escrow back through the committee's `restore`.

### 8.6 Review of the shielded mode (2026-09-08)

Four internal reviewers (circuit, contract and field arithmetic, client, privacy claims)
worked Brief 5 in parallel; Codex's report follows separately. Findings and fixes are in
[03-security-review.md](03-security-review.md) under "Shielded mode". The one critical item,
the spending scalar not bounded below the subgroup order (up to five nullifiers per note),
was fixed in the circuit the same day (revision 4, 29,826 constraints, same public signals),
with a new rehearsal key and a testnet redeploy.

### 8.7 Milestones, revised

| # | milestone | done when |
|---|---|---|
| S7 | circuit revision: `senderPk` output, `sender` bound; library, tests, rehearsal setup. **Done 2026-09-08**: 29,523 constraints, **33 public signals** (value and token packed into one word; the auditor ciphertext dropped the sender key since the action names the sender; 26 outputs + 7 inputs); the action carries 28 words, the contract supplies `senderPk`, `sender` and `A`. Test adds: another signer, a substituted sender key and a redirected destination are all rejected | `npm run test:shielded` green |
| S8 | contract revision: signed `transfer`, key check, sender-paid RAM, relay removed; vert tests including "right key, wrong signer" and "wrong key, right signer". **Done 2026-09-08**: `transfer(sender, proof, publics)` with `require_auth`, the verifier input assembled on chain from the 28 action words plus the registered key, the sender name and the auditor key; withdrawals to self only; a testnet-only `reset`. Tests: wrong signer, another account presenting alice's proof, alice signing a proof made with bob's key, foreign auditor key, unregistered sender, redirected withdrawal, reset and re-init | tests green |
| S9 | testnet redeploy of `xprshield`, demo script signs as the sender, auditor still names both parties. **Done 2026-09-08**: contract redeployed, tables reset and re-initialised with the revision-2 verifying key, the relay permission unlinked and deleted; paul123 deposited 500 XPR (8.4 ms), signed a shielded 123.4 XPR payment to testclient1 (tx `f13cf7f9…`, **14.2 ms CPU**, 28 public words in the action), testclient1 withdrew 100 XPR to itself (tx `28baaa69…`, 14.1 ms); `audit` names the receiver from the auditor key and the sender from the action | a transfer on the explorer shows the sender's authorisation and no receiver |
| S10 | dapp: wallet-signed send and withdraw, relay key removed, copy updated. **Built 2026-09-08** (lesson: `/circuit/` files are cached for a year, so a new circuit needs a new file name; the first tester hit the old circuit and saw the prover's "Signal sender not found"): `prepareSend` / `prepareWithdraw` build the proof on the device and return the `transfer` action for the wallet; the relay key and the signing library are gone from the bundle; the derived key is memory-only for K1 wallets. Headless check against testnet: the browser's proof verifies against the circuit's key with the 33 words the contract assembles, and fails for another signer; the action carries 28 words and names paul123 as both sender and signer. **Closed 2026-09-08**: a tester's wallet-signed 1 XPR payment from the site reached paul123 (tx `4def499b…`; paul123's scan shows the new note) | a tester pays another tester from a phone |
| S11 | Codex review (Brief 5) and fixes; circuit frozen; `reset` removed and `restore` added; phase-2 ceremony for the join-split circuit; `setvk`. **Partly built 2026-09-08**: reviews closed and fixes in; `restore` in, `reset` behind the `TESTNET` flag; the shielded page has Statement, Activity, Auditor and Settings tabs and its own How it works at `/shielded/about` (a separate shield site was tried and retired the same day, see 8.5); recovery parity built (8.5). The Auditor tab opens every note with the committee key and names the sender from the signed `spend` in history (the contract's tables do not keep the signer). Third review round (docs/03) closed the same evening: owner-paid deposit slot, low-order ephemeral keys refused, pinned auditor key and two-node-checked scans in the client. **Circuit revision 5** (2026-09-08 night): dummy nullifier for a disabled input (hides one-note versus two-note payments), `esk` bound below L; `leaves` table folded into `outputs`. **Revision 6** (2026-09-09): several trees with automatic rollover so spending is never blocked; leaf indices are global (tree · 2^20 + position), the tree is a public input the contract takes from the root it looked up, both inputs of a payment sit in one tree; 31,708 constraints, 28 public signals. Still open: the phase-2 ceremony on revision 6 and `setvk` | review closed, ceremony verified |
| S12 | mainnet account `xprshield` under the committee; contract deployed and hashed; tokens and caps set; the mainnet site's Shielded tab enabled; auditor tooling reading both ledgers | a shielded payment on mainnet |
