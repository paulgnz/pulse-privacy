# 06 — Shielded transfers: hiding who pays whom (design, 2026-09-08)

Decision: build a second contract, `xprshield`, in which a payment shows neither the sender nor
the receiver on chain, test it on testnet, and keep the current `xprconf` untouched. The auditor
keeps full visibility, so this is still confidential-with-compliance, not anonymity from
everyone. This page is the design; the milestones are at the end.

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
| `register(account, pk)` | account | as today |
| `transfer(proof, publics)` | none checked; submitted by `xprshield@relay` or anyone | verify proof; `root` must be in `roots`; each non-zero `nf` must be new, then stored; append `cm_1`, `cm_2` as a pair; update root; if `v_pub > 0` pay `to` and count the withdrawal; emit nothing else |
| on `transfer` notification | token contract | memo `shield:rho:r`; caps; compute `cm`; append |
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

- Hidden: the sender, the receiver and the amount of every payment inside the pool; which
  notes were spent; how many notes anyone holds.
- Visible: who deposited how much and when; who withdrew how much and when; that a transfer
  happened, with its two nullifiers and two commitments; the size of the pool.
- Inference: with few users, "someone in the pool paid someone in the pool" narrows quickly.
  Deposit-then-withdraw of matching amounts at close times is linkable, as in every shielded
  pool. Both are documented for users, not solved.
- The auditor sees everything, by design.
- Network level: the RPC node sees the IP that submitted a transfer. A public RPC or a relay
  spreads that; not addressed in v1.

## 6. Relation to `xprconf`

`xprconf` stays as it is: it is simpler, cheaper per transfer, and its ledger is readable by
name. The shielded contract is a separate product with its own escrow. If it proves out, a
migration path is "withdraw from one, deposit into the other". They share the registration
idea, the key derivation, the auditor key, the dapp shell and the ceremony's phase 1.

## 7. Milestones

| # | milestone | proves | done when |
|---|---|---|---|
| S0 | this design | the shape is agreed | page committed |
| S1 | Montgomery field multiplication and Poseidon in AssemblyScript, matching circomlibjs bit for bit; a bench action on testnet. **Done 2026-09-08**: `contracts/xpr-shield-tsc/` (`fr.ts`, `poseidon.ts`, `shbench.contract.ts`, conformance test), numbers in §3.1 | the on-chain hashing budget | measured CPU for Poseidon(2) and a 21-hash insertion, recorded here |
| S2 | join-split circuit, note library, tests, rehearsal setup on the existing 2^16 ptau. **Done 2026-09-08**: `circuits/shielded/joinsplit.circom` (**31,418 constraints** with `--O2`, 38 public signals), `circuits/lib/notes.mjs`, `test/joinsplit.test.mjs` (two-in two-out, dummy input, withdrawal, receiver and auditor decryption, six refusals, prove + verify, redirected withdrawal rejected); proof **≈ 1.4 s in Node**; rehearsal zkey `build/joinsplit_final.zkey` | the statement, constraint count, proving time | `npm run test:shielded` green |
| S3 | the contract with vert tests for every action, including double spend, stale root, wrong token, relayer redirect. **Done 2026-09-08**: `contracts/xpr-shield-tsc/assembly/xprshield.contract.ts` (78 KB WASM; tables config, tokens, keys, leaves, tree, roots, nullifiers; actions init, addtoken, setvk, setauditor, pause, viewkey, register, transfer, and the deposit notification), `tests/xprshield.test.mjs` under vert with real proofs: deposits match the library's tree, relay-submitted transfer, double spend, tampered publics, foreign auditor key, proof against a previous root accepted, redirected withdrawal refused, withdrawal paid, pause | the semantics | tests green |
| S4 | testnet deployment on a new account, relay permission, CLI demo: register, deposit, shielded transfer, withdraw; auditor CLI reads it back. **Done 2026-09-08** on testnet account `xprshield`: relay permission `xprshield@relay` with a published key linked to `transfer`; paul123 deposited 500 XPR (tx `cf1764d8…`, 8.7 ms), two shielded payments of 123.4 XPR to testclient1 submitted by the relay (tx `98f69751…`, **14.5 ms CPU**, no account named in the action), testclient1 withdrew 100 XPR to its public account, and `testnet-demo.mjs audit` lists every leaf as `paul123 → testclient1 1,234,000` from the auditor key alone. Receivers rebuild their notes from the `outputs`, `leaves` and `nullifiers` tables with no history indexer | end to end on a live chain | the explorer shows a transfer with no names and the auditor names both parties |
| S5 | dapp: shielded mode on the testnet site (statement from notes, send and withdraw without wallet prompts, activity from decrypted notes) | usable by testers | testers send to each other |
| S6 | review briefs, phase-2 ceremony, `setvk`, then the mainnet decision | | |

Not in scope until S6: fee for RAM, split viewing keys, subtree caching, hosted relay.
