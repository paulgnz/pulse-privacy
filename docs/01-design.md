# 01 — Design: confidential transfers with auditability

**Date:** 2026-09-07. **Status:** Phase-0 draft, for review. Builds on [00-scoping.md](00-scoping.md);
numbers from [`bench/`](../bench/README.md). Where this document contradicts the scoping page,
this document is right and the scoping page should be updated (§9 lists the corrections).

---

## 0. The answer in one page

**Question.** If alice sends 1234 XPR to bob, the chain shows 1234 leaving alice and 1234 arriving
at bob. How does that become private? Do we need a private version of XPR Network / PulseVM, or can
this be bolted on?

**Answer.** It is a bolt-on. Nothing about XPR, `eosio.token`, accounts, permissions, consensus,
explorers or existing contracts changes. Three things are added:

1. **One new contract** (call it `xpr.conf`) that holds public XPR in escrow and keeps every
   balance and every transfer amount as an *encrypted number* instead of a plain number.
2. **A small set of host functions** (Leap's `CRYPTO_PRIMITIVES`: `alt_bn128_add/mul/pair` and
   friends) so the contract can check a zero-knowledge proof in ~2 ms instead of ~2 s. **XPR mainnet
   already has these** (Leap v3.1.2, `CRYPTO_PRIMITIVES` activated at block 220,936,766). PulseVM
   does not yet; that is the Phase-1 PR.
3. **Wallet support**: an extra key derived from the wallet seed (the *viewing/encryption key*), a
   prover that runs on the user's device, and a decrypt path so the wallet can show the balance.

The chain still shows *that* alice paid bob, and *when*. It no longer shows *how much*. Alice, bob
and the designated auditor can read the amount; nobody else can, validators included. Deposits into
and withdrawals out of the confidential contract stay public, because they move public XPR.

**Proof system:** Groth16 on bn254. Verify ≈ 0.8–2.5 ms native, 128-byte proofs, and it uses exactly
the intrinsic set Antelope already standardised. Bulletproofs (no trusted setup) verified at ≈ 1.5 ms
with ≈ 1 KB proofs and would need a bespoke host function; it stays the fallback.

**One correction that matters:** the scoping page assumed a WASM verifier would be 100× slower than
native. Measured under pulsevm's own wasmer-LLVM it is only 3–4× slower in wall-clock. But pulsevm
bills *instruction points*, not wall-clock, and its point scale over-bills pure arithmetic by ≈ 600×:
a 2.85 ms WASM verify is **billed as 1.76 s, twelve times the per-transaction limit**. So on PulseVM
the intrinsics are mandatory after all, for a different reason than the one written down.

---

## 1. ELI5: how 1234 XPR from alice to bob becomes private

### 1.1 Why it is visible today

The `eosio.token` contract keeps a table row per account: `alice → 5000.0000 XPR`. A transfer is an
action whose fields are `from=alice, to=bob, quantity=1234.0000 XPR, memo`. Every validator executes
it, subtracts 1234 from alice's row, adds 1234 to bob's row. The row and the action are plain data;
explorers print them.

You cannot "encrypt" that and keep it working, because every validator must be able to check that
alice actually had 1234 and that the arithmetic is right. If they cannot see the numbers, how can they
check? That is the whole problem, and the solution has three parts.

### 1.2 Part one: locked boxes you can add without opening

Instead of storing `5000`, the contract stores a **locked box** containing 5000. The box has a special
property: if you have a box containing 5000 and a box containing 1234, you can produce a box containing
3766 (or 6234) **without opening either**. Mathematically the boxes are ElGamal ciphertexts and the
property is *additive homomorphism*; the contract does elliptic-curve point additions on them.

So the contract can keep everyone's balance in boxes and move value between boxes by box arithmetic.
It never needs to open a box. Every validator does the same box arithmetic and gets the same boxes,
so consensus is unaffected.

### 1.3 Part two: a stamp that says "the contents are valid" without showing them

Box arithmetic alone is not enough. Alice could put "−1,000,000" in the transfer box and give herself
money, or put "999,999,999" and drain bob's counterparty exposure. The validators need to check that:

- the amount in the transfer box is a sensible number (0 ≤ amount < 2⁶⁴), and
- alice's balance box minus the transfer box still contains a number ≥ 0 (she is not overdrawn), and
- the copies of the box addressed to alice, bob and the auditor all contain the **same** number.

A **zero-knowledge proof** is a stamp alice attaches that convinces anyone of those three facts
while revealing nothing else. It is 128 bytes and takes a validator about two milliseconds to check
with the right host functions. Alice's wallet produces it in well under a second on a laptop and a few
seconds on a phone. If the stamp does not check out, the contract rejects the action exactly as it
would reject an overdraft today.

### 1.4 Part three: every box has two keyholes

Each box is made so that it opens with the recipient's key **and** with a designated auditor's key.
That is not a backdoor bolted on afterwards; it is part of what the stamp proves ("the copy for the
auditor contains the same number as the copy for bob"). A transfer that is not readable by the auditor
cannot be constructed, because the proof would fail. This is what makes it *confidential*, not
*anonymous*: a supervisor with the viewing key sees every amount, and everybody else sees nothing.

### 1.5 The walk-through

| step | action on chain | what an observer sees | what alice / bob / auditor see |
|---|---|---|---|
| 1 | alice deposits 5000 XPR into `xpr.conf` | `alice → xpr.conf 5000.0000 XPR` (public, it is a normal token transfer into escrow) and alice's box created | everyone knows alice's box holds 5000 at this moment |
| 2 | alice → bob confidential transfer | `alice → bob`, a 4×64-byte ciphertext, a 128-byte proof; alice's box replaced, bob's *pending* box grows | alice: −1234; bob: +1234 pending; auditor: 1234 |
| 3 | bob's wallet folds pending into available (`applypending`, or lazily on his next send) | bob's boxes change | — |
| 4 | carol → alice, dave → bob, bob → erin, … | more `X → Y` rows with ciphertexts | each party sees their own amounts; the auditor sees all |
| 5 | bob withdraws 1000 XPR | `xpr.conf → bob 1000.0000 XPR` (public) | — |

After step 2 an observer knows alice's box holds *some* number in [0, 5000] and bob's holds *some*
number ≥ 0. After step 4 the observer knows less and less about each individual box; the auditor still
knows everything.

### 1.6 What stays visible, honestly

- **Who paid whom, and when.** Parties are named accounts. This is by design (Level 1 in the scoping
  page). Hiding counterparties is a different, decision-gated design (Phase 3).
- **Deposits and withdrawals.** Public XPR moving into or out of the escrow is a public transfer.
  If alice deposits 1234, sends bob one confidential transfer, and bob withdraws 1234 an hour later,
  anyone can guess the amount. Privacy comes from *staying inside* and from *volume*: the more
  accounts and transfers inside the pool, the less a boundary amount says. This is the same property
  as every shielded-pool design (Zcash, Solana Token-2022 confidential transfers, Aztec) and the wallet
  UX should say so plainly.
- **Transaction count and timing.** An observer can count how often alice pays bob.
- **Nothing is hidden from the auditor**, by construction.

Think of it as a bank statement where the counterparties and dates are printed and the amount column
is blacked out for everyone except the account holders and the regulator.

### 1.7 So: private chain or bolt-on?

Bolt-on. Validators do not need to see amounts to validate: they check a stamp and do box arithmetic.
A separate "private version of XPR" would add nothing for amount privacy: validators on that chain
would see exactly the same ciphertexts. A dedicated chain only makes sense for the Phase-3 question
(hidden counterparties in a regulated zone), which is a product decision, not a technical need.

What *is* needed from the chain is the host functions. On XPR mainnet (Leap v3.1.2) they are live
today, so a C++ CDT build of the contract is deployable there without any node change. On PulseVM they
are missing; adding them is a protocol-feature activation, the additive, gated kind of upgrade — a node
release plus a scheduled feature, not a fork.

### 1.8 The usage model: the receiver holds the asset in the contract

The confidential balance **is** the balance, not a waiting room on the way to a public one. Bob
receives in the pool, holds in the pool, and pays others in the pool. Withdrawing is the exception,
done rarely and in round amounts, when someone needs public XPR for something outside. Under that
model the boundary leak of §1.6 rarely arises: if bob never withdraws 1,234.5679 there is nothing
to match. Consequences for the product:

- the wallet shows the confidential balance as a first-class balance next to public XPR, with
  confidential send as the default action, not a special mode;
- receiving is passive (the pending bucket) and folding is automatic on the next send;
- merchants and payroll are the first receivers to onboard, because every payment that stays
  inside is one fewer edge for everyone;
- the first deposit is the one edge everyone crosses; it reveals a starting amount once, after
  which the observer's knowledge decays to loose bounds and never sharpens again unless the user
  withdraws.

Confidential XPR is spendable only where the counterparty has registered an encryption key.
Paying an ordinary contract or an unregistered account still means withdrawing first.

### 1.9 Edge privacy: what leaks at deposit/withdraw and what helps

Inside the pool amounts are hidden cryptographically. At the edges they are hidden
**statistically**, and the design makes that explicit rather than pretending otherwise.

| what leaks | how |
|---|---|
| the deposit amount | it is a public `eosio.token` transfer into escrow |
| the withdrawal amount | it is a public `eosio.token` transfer out of escrow |
| an *inference* about a transfer | matching a unique amount and a short time gap across the two edges (alice deposits 1,234.5679, one transfer, bob withdraws 1,234.5679) |

| measure | effect | where |
|---|---|---|
| **round amounts at the edges** (`withdraw_granularity`, e.g. whole XPR or multiples of 10/100, per token) | removes the fingerprint; a round amount is shared with everyone else | contract, enforced in `withdraw`; wallet nudges the same on deposit |
| **edge-matching warning** | before a withdrawal, the wallet compares the amount to recent incoming transfers and their sums and to pool activity since; warns and suggests a round amount and a delay; never a hard block | wallet |
| **time and volume** | privacy at the edge is proportional to the number of other deposits/withdrawals in between; shown as an honest indicator ("12 withdrawals since your last incoming transfer") | wallet |
| **no plaintext memo** | the confidential `transfer` carries no memo, or an encrypted one | contract |
| splitting a withdrawal into chunks | **does not help**: an analyst sums; only time and volume do the work | — |
| withdrawing to another account | **does not help**: the withdraw is still signed by the owner and parties are public by design | — |

The contract cannot enforce "not an amount that was sent to you" because it never learns
amounts; only the wallet (and the auditor) can. Hence the split: the chain enforces granularity,
the wallet handles the judgment call. The only ways to remove the edge entirely are to make the
destination confidential too (a confidential swap into another confidential token) or the
Phase-3 shielded design; both still show the amount leaving the system, as Zcash's
shielded-to-transparent does.

---

## 2. Cryptographic design

### 2.1 Curves and why two of them

| role | curve | why |
|---|---|---|
| zero-knowledge proof | **bn254** (Groth16) | Antelope's `alt_bn128_*` intrinsics are bn254; EVM precompiles are bn254; largest tooling and ceremony ecosystem |
| balance / amount encryption | **Baby Jubjub** (twisted Edwards, `ark-ed-on-bn254`) | its base field *is* bn254's scalar field, so encrypting/decrypting inside the circuit costs a few thousand constraints instead of millions; the contract's homomorphic adds on it cost 0.3 µs in WASM |

The contract never touches Baby Jubjub scalar multiplication (expensive); only additions (cheap, §2.6).
The wallet does the scalar multiplications.

### 2.2 Twisted ElGamal (the "boxes")

Generators `G`, `H` on Baby Jubjub (nothing-up-my-sleeve, hash-to-curve). Each participant X has an
encryption secret `s_X` and public key `P_X = s_X⁻¹·H`.

Encrypting amount `v` with fresh randomness `r`, addressed to parties {sender, receiver, auditor}:

```
C   = v·G + r·H              # Pedersen commitment, shared by all three
D_X = r·P_X                  # one "decryption handle" per party
```

A ciphertext for one party is `(C, D_X)`. Decryption: `C − s_X·D_X = v·G + r·H − r·H = v·G`, then
recover `v` from `v·G` by baby-step giant-step (12.5 ms worst case per 32-bit chunk, §2.3).

Why twisted ElGamal rather than textbook ElGamal: the commitment `C` is shared, so "alice's copy, bob's
copy and the auditor's copy encrypt the same number" is automatic. The circuit only has to prove the
three handles are well-formed (`D_X = r·P_X` with the same `r`), which is three cheap scalar
multiplications by a 254-bit `r`. This is the construction Solana Token-2022 uses, ported from
ristretto to Baby Jubjub so it fits in the SNARK.

Homomorphism: `(C₁ + C₂, D₁ + D₂)` encrypts `v₁ + v₂`. That is the only operation the contract needs.

### 2.3 Amount encoding: two 32-bit chunks, not 48 bits

Antelope amounts are `int64` (XPR has 4 decimals; the supply is 3.24 × 10¹⁴ units ≈ 2⁴⁸·²). Solana's
16-bit + 32-bit split gives 48 bits and **would not cover XPR's supply**. We encrypt an amount as two
independent 32-bit chunks `v = lo + 2³²·hi`, each its own ciphertext. Decrypting a chunk is a
discrete log in [0, 2³²): baby-step table of 2¹⁶ points (15 ms to build once, cacheable) and at most
2¹⁶ giant steps (12.5 ms native on the M4, measured). A balance is therefore two ciphertexts, a
transfer is two ciphertexts × three handles.

Chunk overflow: bob's *pending* lo-chunk accumulates `Σ lo_i` over many incoming transfers and may
exceed 2³². That is harmless because (a) the wallet learns each incoming amount by decrypting the
individual transfer ciphertext (32-bit, cheap), not the aggregate, and (b) the sender's next transfer
**re-encrypts its balance in normalised chunks** (§2.4), so un-normalised chunks never need to be
decrypted by BSGS. A wallet recovering from seed with no local history replays its transfers from
the chain (Hyperion / the auditor CLI does the same), which is the normal Antelope way to rebuild
state anyway.

### 2.4 The transfer statement (what the proof proves)

Public inputs (all Baby Jubjub points as (x, y) field elements, ≈ 40 field elements total):

| symbol | meaning |
|---|---|
| `P_s, P_r, P_a` | sender, receiver, auditor encryption public keys (from tables) |
| `B_old = (C_lo, D_lo, C_hi, D_hi)` | sender's current available-balance ciphertexts (from table) |
| `B_new` | sender's new available-balance ciphertexts (supplied by sender) |
| `T = (C_lo, D_lo^s, D_lo^r, D_lo^a, C_hi, …)` | the transfer amount ciphertexts (supplied by sender) |
| `nonce`, `sender`, `receiver` | binds the proof to this account pair and this transfer counter |

Witnesses: `s` (sender's secret), `v_old`, `v` (amount), `v_new`, chunk decompositions, randomness
`r_T, r_new`.

Constraints:

1. `v_old·G == C_old − s·D_old` for both chunks (sender knows the plaintext of the balance on record).
2. `v_new = v_old − v`, with `v ∈ [0, 2⁶⁴)` and `v_new ∈ [0, 2⁶⁴)` (bit decomposition; no overdraft).
3. `T` is a correct twisted-ElGamal encryption of `v` (in normalised 32-bit chunks) under `P_s, P_r, P_a`
   with one shared `r_T` per chunk.
4. `B_new` is a correct encryption of `v_new` (normalised chunks) under `P_s` with fresh `r_new`.
5. `s·P_s == H` (the secret matches the registered public key).
6. `nonce, sender, receiver` are constrained as public inputs so the proof is single-use and
   non-transferable.

Circuit size estimate: ≈ 15 Baby Jubjub scalar multiplications (≈ 3k constraints each with the
standard Edwards gadget), 128 bits of range checks, glue: **≈ 50–60k constraints**, Powers-of-Tau
2¹⁶. Proving ≈ 0.5 s laptop / 2–5 s phone (arkworks native) / 5–10 s browser (WASM). Proof 128 B.

Public-input count and cost: the contract verifies with `n_pub` × `alt_bn128_mul` + `alt_bn128_add`
+ one 4-pair `alt_bn128_pair`. At ≈ 40 inputs that is ≈ 2.4 ms native (measured 1.7 ms at 24 inputs,
3.9 ms at 64). The usual trick of hashing all public inputs into one field element with Poseidon
*inside the contract* is **not** a win on pulsevm: ≈ 1,300 field multiplications in WASM bill at
≈ 100 ms under the current metering. Direct public inputs through intrinsics are cheaper and simpler.

### 2.5 Available vs pending (the front-running fix)

If bob's balance ciphertext changed every time someone paid him, a proof bob built a second ago
against his old balance would be invalid on arrival, and a hostile third party could grief him by
dusting. So incoming credits land in a **pending** ciphertext that only the receiver folds into
**available** (`applypending`). A proof only ever references the sender's *available* balance, which
only the sender's own actions change. The wallet does `applypending` automatically before building a
transfer, in the same transaction, so the user never sees it.

### 2.6 What the contract computes per transfer (and what it bills)

| step | operation | cost |
|---|---|---|
| verify proof | 40 × `alt_bn128_mul`, 40 × `alt_bn128_add`, 1 × `alt_bn128_pair` (4 pairs) | ≈ 2.4 ms native; billed by intrinsic price (§5.2) |
| sender balance | replace `B_old` with `B_new` | table write |
| receiver pending | 4 Baby Jubjub point adds (C and D_r, two chunks) | 4 × 0.29 µs wall, 4 × 0.2 ms billed (§5.2) |
| auditor | nothing; `D_a` is in the action data, indexed by history | — |

Store balance points in **projective/extended coordinates** (3–4 field elements). Storing affine and
normalising after every add is 4 µs wall but 1.3 ms billed under current metering; not worth it.

### 2.7 Keys

| key | where it lives | derived from | used for |
|---|---|---|---|
| Antelope signing key (R1 in Secure Enclave, or K1) | unchanged | unchanged | signing the transaction, as today |
| **encryption secret `s`** | wallet core, in memory when unlocked | `HKDF(seed, "pulse-privacy/elgamal/v1" ‖ account)` | decrypting own balance and incoming transfers; witness in the proof |
| encryption public key `P = s⁻¹·H` | on chain, `accounts` table | `s` | others encrypt to it |
| **auditor viewing key `s_a`** | supervisor's HSM / offline machine | supervisor's choice | decrypting every transfer; never used to *spend* |

The Secure Enclave key cannot do ECDH or export, so `s` must be a separate secret derived from the
seed (scoping §2 wrinkle). **Losing `s` means losing the ability to read the balance and therefore
the ability to build a proof: it is a spending precondition, not just a history key.** Recovery of
`s` is recovery of the seed, so it rides the existing account-recovery flow with nothing extra —
provided the wallet derives it from the seed and never stores it standalone. Auditor key rotation:
`configure` publishes a new `P_a`; transfers after that block are readable by the new key, earlier
ones by the old key. The supervisor keeps both; the contract keeps a history of `(block, P_a)`.

### 2.8 Trusted setup

Groth16 needs a circuit-specific phase-2 ceremony. Plan: reuse a public Powers-of-Tau (Hermez /
Perpetual Powers of Tau, ≥ 2¹⁶), then a phase-2 with ≥ 5 independent contributors (Metallicus, three
or more block producers, one external), published transcripts, verifiable with standard tooling. The
security assumption is that at least one contributor destroyed their randomness. If that is
operationally unacceptable, Bulletproofs (§3) removes the ceremony at the cost of a bespoke intrinsic.

Circuit tooling is an open choice (§8). Recommendation: write the circuit in **circom** (mature
phase-2 ceremony tooling, browser WASM prover, verifier-key export), and have `pulse-wallet/core`
prove with `ark-circom` (arkworks Groth16 under the hood, identical proof format). This keeps the Rust
wallet crate arkworks-only while borrowing circom's ceremony ecosystem.

---

## 3. Groth16 vs Bulletproofs — decision with numbers

| | Groth16 / bn254 | Bulletproofs / ristretto255 |
|---|---|---|
| verify, native | 0.8 ms (1 input) … 2.4 ms (40 inputs) | ≈ 1.5–2 ms (two 64-bit range proofs + sigma protocols) |
| proof size | 128 B | ≈ 1 KB |
| prove, laptop | ≈ 0.2–0.5 s | ≈ 10–20 ms |
| host functions needed | Antelope-standard `CRYPTO_PRIMITIVES` (already on XPR mainnet) | bespoke ristretto MSM / range-verify intrinsic (upstream sell, no precedent) |
| trusted setup | yes (phase-2 ceremony) | none |
| circuit flexibility | arbitrary statement in one proof | each statement is its own sigma protocol; adding auditor handles adds proofs |
| precedent | Zcash Sapling, Aztec, Tornado, EVM rollups | Solana Token-2022 confidential transfers |

**Decision: Groth16 on bn254.** The verifier is cheaper, the proof is 8× smaller, the intrinsic set is
standard and already live on XPR mainnet, and one circuit carries the whole statement. Bulletproofs
stays as the fallback if the ceremony is rejected. Proving cost is the price and it is acceptable.

---

## 4. Contract specification (`xpr.conf`, pulse-cdt-rust)

One contract per chain, scoped by token symbol like `pulse_token` (so `XPR`, `XUSDC`, … are
rows, not deployments). Escrow: the contract holds the public tokens; confidential supply per
symbol equals the escrow balance at all times.

### 4.1 Tables

```rust
// scope = symbol code
#[table(primary_key = row.owner.raw())]
pub struct Account {
    pub owner: Name,
    pub enc_pubkey: JubPoint,            // P = s⁻¹·H, 64 B compressed to 32 B on disk
    pub avail: [Ciphertext; 2],          // lo, hi: (C, D) each, projective coords
    pub pending: [Ciphertext; 2],        // lo, hi
    pub pending_count: u32,              // credits since last applypending (UX / rate limit)
    pub nonce: u64,                      // outgoing transfer counter, bound into every proof
}

#[table(primary_key = row.sym.raw())]
pub struct Config {
    pub sym: Symbol,
    pub token_contract: Name,            // eosio.token
    pub auditor_pubkey: JubPoint,
    pub auditor_history: Vec<(u32, JubPoint)>,   // (activation block, key)
    pub vk_hash: Checksum256,            // hash of the Groth16 verifying key in `vkeys`
    pub withdraw_granularity: u64,       // withdrawals must be a multiple (units); 0 = off
    pub deposit_granularity: u64,        // same for deposits; 0 = off (wallet nudges regardless)
    pub paused: bool,
}

#[table(primary_key = row.id)]
pub struct VerifyingKey { pub id: u64, pub vk: Vec<u8> }   // raw, ~1–3 KB
```

### 4.2 Actions

| action | auth | what it does | proof? |
|---|---|---|---|
| `register(owner, enc_pubkey, pok)` | owner | creates the account row with zero balances; `pok` is a Schnorr proof of knowledge of `s` (prevents key-substitution games) | Schnorr, in WASM (2 Baby Jubjub muls: ≈ 70 µs wall) |
| `deposit` (via `on_notify` of `eosio.token::transfer` with memo `conf:<owner>`) | token contract | amount is public; contract encrypts it *deterministically* (`r = 0`, so `C = v·G`, `D = 0`) into the owner's pending | none needed: everyone can recompute |
| `transfer(from, to, T, B_new, proof)` | from | verifies the Groth16 proof against `(P_s, P_r, P_a, B_old, B_new, T, nonce, from, to)`; replaces `from.avail`; adds `T` into `to.pending`; `nonce += 1`; emits `T` in the action trace for history | Groth16 |
| `applypending(owner)` | owner | `avail += pending` (homomorphic), `pending = 0`, `pending_count = 0` | none |
| `withdraw(owner, amount, B_new, proof)` | owner | checks `amount % withdraw_granularity == 0`; proves `B_new` encrypts `v_old − amount` with `amount` public; replaces `avail`; inline `eosio.token::transfer` of `amount` from escrow to owner | Groth16 (same circuit, amount public) |
| `configure(sym, auditor_pubkey, withdraw_granularity, deposit_granularity, paused)` | contract (msig) | rotates auditor key (appends to history), sets edge granularities (§1.9), pause switch | — |
| `setvk(id, vk)` | contract (msig) | installs / rotates the verifying key after a ceremony | — |

`transfer` carries **no plaintext memo** (§1.9). `deposit` encrypting with `r = 0` is deliberate: the deposit amount is public anyway, and it removes
any need for the depositor to be online or to prove anything. The auditor handle is trivially zero.

Withdraw uses the same circuit with the amount exposed as a public input rather than a second
circuit; it saves a ceremony.

### 4.3 Security properties enforced by the contract

- **No inflation:** every `avail` change is either a proven re-encryption of `old − v` (transfer,
  withdraw) or a homomorphic add of a proven-in-range or public amount (pending, deposit).
- **No overdraft:** range check on `v_new` in the proof.
- **No replay:** the proof binds `nonce`, `from`, `to`, and `B_old`; after one use `B_old` and `nonce`
  are gone.
- **Auditor completeness:** every transfer ciphertext carries `D_a` proven under the auditor key
  current at that block.
- **Front-running:** available/pending split (§2.5).
- **Griefing via pending:** `pending_count` lets the wallet know when to fold; a cap (e.g. 1024) with
  a rejection beyond it bounds the lo-chunk accumulation; deposit dust is a RAM cost, not a
  correctness issue.

---

## 5. Host functions (Phase-1 PR to pulsevm)

### 5.1 The set

Exactly Leap's `CRYPTO_PRIMITIVES` (Leap 3.1, `builtin_protocol_feature_t::crypto_primitives`),
same signatures, same encoding (EIP-196/197 big-endian points, EVM precompile semantics for failure):

```
int32 alt_bn128_add (const char* op1, uint32 op1_len, const char* op2, uint32 op2_len, char* result, uint32 result_len)
int32 alt_bn128_mul (const char* g1, uint32 g1_len, const char* scalar, uint32 scalar_len, char* result, uint32 result_len)
int32 alt_bn128_pair(const char* pairs, uint32 pairs_len)                      // 0 = pairing == 1
int32 mod_exp       (base, exp, mod, out)
int32 blake2_f      (rounds, state, message, t0, t1, final, result)
void  sha3          (data, len, hash, keccak: int32)
int32 k1_recover    (sig, sig_len, dig, dig_len, pub, pub_len)
```

Rust-native (`ark-bn254` / `ark-ec`, or `blst`-style constant-time if #64's BLS crate makes that the
house library), behind `ProtocolFeature::CryptoPrimitives => 2`, with Leap's unit-test vectors ported.
This closes wiki/49 row 1 and, incidentally, is a **migration-parity item**: XPR mainnet contracts can
call these today and PulseVM would fail to run them.

### 5.2 Pricing the intrinsics

pulsevm bills points, so each intrinsic needs a fixed point cost (Leap measures wall-clock and needs
none). Proposal, from the native medians × `CPU_SCALE = 143`, with a 2× safety margin for the slowest
validator class:

| intrinsic | native median (M4) | proposed points | billed µs |
|---|---:|---:|---:|
| `alt_bn128_add` | 1.7 µs | 500 | 3.5 |
| `alt_bn128_mul` | 42 µs | 12,000 | 84 |
| `alt_bn128_pair`, per pair | ≈ 100 µs + 200 µs base | 30,000 + 60,000 base | 210/pair + 420 |
| `mod_exp`, `blake2_f`, `sha3`, `k1_recover` | to measure in Phase 1 | | |

A 40-input Groth16 verify then bills ≈ 40 × 84 + 4 × 210 + 420 ≈ 4.6 ms, ≈ 3 % of the 150 ms limit.
To be re-measured on the `.95` box before the PR; the point costs are consensus-relevant and must be
part of the protocol feature.

### 5.3 Metering finding (side issue, worth its own note to Glenn)

`CPU_SCALE = 143` was calibrated on `placeorder` (DB-heavy). Measured on pure field arithmetic it
over-bills by ≈ 600× (2.85 ms wall → 1.76 s billed). Any compute-heavy contract (hashing loops,
big-int, on-chain light clients, bridges) will hit this. Independent of the intrinsics, the cost
table would benefit from a lower per-op weight for `i64.mul`/shifts/loads relative to DB and memory
operations, or a per-class scale. Not blocking for this track since the proof goes through intrinsics,
but the 0.2 ms-per-point-add bill on the homomorphic update comes from the same distortion.

---

## 6. Wallet and auditor

### 6.1 Wallet (`pulse-wallet/core`)

- **Derivation:** `s = HKDF-SHA256(seed, info = "pulse-privacy/elgamal/v1" ‖ account_name)`, reduced into
  the Baby Jubjub scalar field. Never persisted; re-derived on unlock.
- **State:** the wallet keeps its own plaintext balance and a log of decrypted incoming/outgoing
  amounts, rebuilt from chain history on recovery. The on-chain ciphertext is *verified* against this
  (decrypt and compare) but not the primary source, which avoids BSGS on un-normalised chunks.
- **Send flow:** `applypending` (if `pending_count > 0`) → decrypt `B_old` (check) → build witness →
  prove (arkworks, ≈ 0.5 s laptop) → assemble tx `[applypending, transfer]` → sign with R1/K1 as today →
  `send_transaction`. Before sending, estimate CPU against `get_info` / account limits; a proof
  transaction that would exceed the budget is **refused by the wallet**, because pulsevm's admission
  gap (#76) drops such transactions silently.
- **Withdraw flow:** before building the proof, run the edge-matching check (§1.9): compare the
  amount to recent incoming transfers and sums of them, and count pool edges since the last
  incoming transfer; warn, suggest a round amount and a delay; never block.
- **Receive:** subscribe to `transfer` actions where `to = me`; decrypt `(C, D_r)` chunks; show the
  amount; fold pending lazily.
- **Prover targets:** native (macOS/iOS via uniffi, Tauri desktop), `wasm-bindgen` for web. Proving
  keys (≈ 20–40 MB for 2¹⁶) ship with the app or are fetched once and hash-checked.

### 6.2 Auditor CLI (`tools/auditor-cli`)

Input: viewing key (from HSM/file), block range or account, RPC/Hyperion endpoint. Output: a ledger
of every confidential transfer with decrypted amounts, sender, receiver, block, tx id, plus deposits
and withdrawals (public). Same BSGS decrypt as the wallet. Verifies that decrypted balances reconcile
to escrow per symbol (a live Proof-of-Reserve for the pool). Hyperion "viewing-key mode" later.

---

## 7. Threat model (Level 1)

| adversary | goal | outcome |
|---|---|---|
| chain observer, validator, explorer | learn any amount | sees only ciphertexts and 128-B proofs; amounts hidden under DDH on Baby Jubjub |
| chain observer | learn counterparties, timing, frequency | **visible by design** |
| chain observer | infer amounts from deposit/withdraw boundary | possible when pool activity is low or amounts are unique; mitigated by usage, not cryptography; wallet warns |
| sender | overdraw / inflate / send negative | prevented by proof (range + balance consistency) |
| sender | exclude auditor | prevented: proof requires a valid `D_a` |
| receiver / third party | invalidate a pending proof by sending dust | prevented: available/pending split |
| anyone | replay or retarget a proof | prevented: proof bound to `nonce, from, to, B_old` |
| key thief with `s` only | spend | cannot: signing still needs the Antelope key; can *read* the balance and history |
| key thief with Antelope key only | spend | cannot build a proof without `s`; can `applypending`/`register` nothing harmful |
| auditor key holder | read everything | **intended**; cannot spend or forge; rotation limits blast radius |
| ceremony collusion (all phase-2 participants) | forge proofs → inflation | mitigated by ≥ 5 independent contributors; detectable after the fact only via escrow reconciliation; Bulletproofs fallback removes this |
| circuit or contract bug | inflation / loss | external audit before institutional use (Phase 2 exit) |

Out of scope: network-level unlinkability, private execution, hiding from the auditor.

---

## 8. Open decisions

1. **Circuit tooling:** circom + `ark-circom` in the wallet (recommended) vs pure arkworks R1CS
   (fewer moving parts, weaker ceremony tooling). Decide at the start of Phase 2.
2. **Pairing crate alignment with #64 (Warp):** `ark-bn254` is the natural fit for Groth16; if #64
   brings `blst` for BLS12-381 there is no bn254 overlap anyway. Confirm with Glenn.
3. ~~Ship a demo on XPR testnet first?~~ **Decided 2026-09-07: yes.** See §11.
4. **Auditor: one key per symbol or one per chain?** Table supports per symbol; policy question.
5. **Point cost of intrinsics** (§5.2): numbers from the `.95` box before proposing.

---

## 9. Corrections to the scoping page

| scoping page said | measured / verified | consequence |
|---|---|---|
| "Proof verification in plain WASM is 100×+ the native cost" | 3–4× wall-clock under pulsevm's wasmer-LLVM | the *reason* intrinsics are mandatory is metering (600× over-billing), not raw speed |
| "CPU billing: producer wall-clock, replayed via `explicit_billed_cpu_time`" | pulsevm bills metering points ÷ `CPU_SCALE` (143); wall-clock is not the billed quantity | intrinsics need fixed point prices; the cost table needs recalibration (§5.3) |
| none of the crypto intrinsics exist (wiki/49 row 1) | true for PulseVM; **XPR mainnet has `CRYPTO_PRIMITIVES` since block 220,936,766 (Leap v3.1.2)** | Phase 1 is a migration-parity item, and a Leap testnet demo is possible now |
| amounts "48-bit like Solana" implied by the Bulletproofs comparison | XPR supply is 2⁴⁸·² units | 2 × 32-bit chunks (§2.3) |
| Groth16 verify ≈ 1–2 ms | 0.8 ms (1 public input) to 2.4 ms (40) native; 4.6 ms billed at proposed prices | fine |

---

## 10. Revised ask for Glenn (one paragraph, replaces scoping §6)

We want to add Leap's `CRYPTO_PRIMITIVES` host functions (`alt_bn128_add/mul/pair`, `mod_exp`,
`blake2_f`, `sha3`, `keccak`, `k1_recover`) as PulseVM's first post-genesis gated feature
(`ProtocolFeature::CryptoPrimitives` → version 2, per `docs/protocol-features.md` §9), Rust-native
with Leap's test vectors. Two things came out of scoping that make this more than a zk nicety: XPR
mainnet has had `CRYPTO_PRIMITIVES` active since block 220,936,766, so this is a migration-parity
gap, and pulsevm's point metering bills pure arithmetic at roughly 600× wall-clock (a 2.85 ms WASM
pairing check bills 1.76 s), so any proof verification in contract WASM is unbillable without
intrinsics. Our use is a confidential-transfer token (hidden amounts, mandatory auditor viewing key;
design at `pulse-privacy/docs/01-design.md`). Three things to align: which pairing crate #64 (Warp)
brings in so we share one; fixed point prices for the new intrinsics (proposal in §5.2, to be
re-measured on validator hardware); and whether the schedule-version-2 dogfood runs on a chain you
run or ours. Separately, the `CPU_SCALE` calibration is worth a look for compute-heavy contracts.

---

## 11. Testnet build (decided 2026-09-07)

**Why now.** XPR testnet runs Leap v5.0.3 with `CRYPTO_PRIMITIVES` active (verified on three
endpoints), and `proton-tsc` already wraps the whole set (`bn128Add`, `bn128Mul`, `bn128Pair`,
`modExp`, `k1Recover`, `sha3`, `keccak`, `blake2`; `@proton/vert` simulates `alt_bn128_*` for local
tests). So the circuit, ceremony, contract logic and real proof timing can be proven on a live
Antelope chain months before the PulseVM intrinsics land, with zero chain work. Leap bills
wall-clock, so a transfer verifying a Groth16 proof costs ≈ 2–4 ms CPU: heavy for an action, fine
for the per-tx limit and a testnet account.

**Without WebAuth changes.** WebAuth signs whatever actions a dapp submits through the web SDK, so
the testnet version is a dapp: it runs the prover in the browser (WASM), builds ciphertexts +
proof, and asks WebAuth to sign an ordinary `send` on the contract. Deposits are plain token
transfers.

**Key custody: the wallet is the key (decided 2026-09-07).** The dapp derives the encryption
secret from a WebAuth signature over a *fixed, never-broadcast* transaction (one `unlock(owner)`
action on the contract, constant expiration and TAPOS fields, so the signing digest is constant).
Standard XPR keys are K1 with RFC 6979 deterministic nonces, so the same account always yields
the same secret on any device: nothing to back up, and recovering the wallet recovers the
confidential balance. Derivation: `secret = SHA-256-expand(domain ‖ chain_id ‖ actor ‖ signature)
mod l`. First-time setup signs twice and compares; if the signatures differ (hardware or WebAuthn
keys randomise nonces) the dapp falls back to a generated key with a mandatory backup. The
secret lives in memory only. Production can move the same derivation inside WebAuth (§2.7) so
no signature prompt is needed, with identical keys.

Refinements after the first testers (2026-09-07): the signed action is now `viewkey(owner, note)`
whose `note` field the wallet displays ("Derives your Confidential XPR viewing key on
private.protonnz.com. Never sent to the chain. Moves nothing."), with a Ricardian clause in the
ABI; a phisher cannot alter the text without changing the derived key. Accounts registered under
the earlier `unlock` message unlock through a one-click legacy path. Each wallet prompt is
requested from its own click (browsers block a second popup from one click), so first-time
setup is "Sign to unlock" then "Sign again to confirm". Known limits of signature-derived keys:
anyone who gets the user to sign the exact message learns the viewing secret (read-only, not
spend); the in-wallet derivation removes this. The SDK must be loaded with dynamic imports for
the mobile app transport to work.

**Milestones (in order; each is a checkpoint that can fail cheaply):**

| # | milestone | proves | artefacts |
|---|---|---|---|
| T1 | **Groth16 verifier on testnet.** ✅ **Done 2026-09-07.** proton-tsc contract `verify(vk, proof, inputs)` deployed to testnet account `xprconf`; an arkworks proof (2 public inputs) verified on chain in tx `ca44bcaf…` (block 404,501,003) at **4,123 µs CPU**; tampered input rejected ("invalid proof"); off-curve point rejected by the host function itself. G2 encoding is imaginary-first as in EIP-197; `@proton/vert` simulates the intrinsics faithfully | encoding conventions, the wrappers, real CPU cost | `contracts/xpr-conf-tsc/`, `bench --emit-evm-fixture` |
| T2 | **Transfer circuit (circom) + ceremony rehearsal.** Twisted ElGamal on Baby Jubjub, 2 × 32-bit chunks, the §2.4 statement; snarkjs phase-2 with a small Powers-of-Tau; vk exported to the contract | the statement, constraint count, prove time in browser and native | `circuits/transfer/` |
| T3 | **Confidential token contract.** Tables and actions of §4 in proton-tsc, including `withdraw_granularity`; Baby Jubjub adds in AssemblyScript (cost measured); vert tests for every action | the contract semantics end to end | `contracts/xpr.conf-tsc/` |
| T4 | **Dapp.** ✅ **Done 2026-09-07, live at <https://private.protonnz.com>.** Vite/React, WebAuth testnet login, real twisted-ElGamal + snarkjs Groth16 prover in the browser (proof ≈ 1.6 s, BSGS decrypt ≈ 20 ms after a 270 ms table build), state from the contract tables, activity/incoming/edges from Hyperion, fold-in-same-tx send/withdraw, §1.9 rules, key export/import, auditor mode with reconciliation. Not yet exercised by a human with a WebAuth wallet (the payloads are the ones the Node demo proved on chain) | the whole flow on testnet without wallet changes | `dapp/` |
| T5 | **Auditor CLI.** ✅ **Done 2026-09-07.** `ledger` / `account` / `reconcile` from Hyperion with the viewing key; reconciles the live testnet (balances reconstructed by summation match the owners' decryptions; escrow = deposits − withdrawals + pre-code transfers) | auditability | `tools/auditor-cli/` |

The contract ports to `pulse-cdt-rust` later with the same tables and actions; the circuit,
vk and dapp carry over unchanged.

**Observations from the testnet build (2026-09-07):**

- A proven `send` costs **≈ 7.8 ms CPU on Leap**: 41 `alt_bn128_mul` + adds + one 4-pair pairing
  (≈ 4 ms, cf. T1) plus 4 Baby Jubjub adds via `mod_exp` and ABI/table overhead. Fine for testnet;
  for production, reducing public inputs (hash them with a *host-function* hash and open it
  in-circuit, or compress points) and native Baby Jubjub adds on PulseVM bring this down.
- Toolchain gotchas worth knowing: `as-chain`'s `U256.toString(16)` is wrong, and its `modExp`
  wrapper depends on it, so the contract binds `mod_exp` directly with byte encoding; `proton-asc`
  needs TypeScript 4.9; a contract needs ≈ 10× its WASM size in RAM (28 KB → 278 KB) and
  `proton contract:set` reports the RAM failure but still deploys the ABI, leaving old code
  under a new ABI (unknown actions are then silently ignored).
- Register has no proof-of-knowledge of the secret in v0 (on-curve check only); the transfer
  circuit binds the sender's key, so a bogus receiver key only harms its owner. Add a Schnorr PoK
  when native Baby Jubjub multiplication is available (PulseVM) or accept the cost on Leap.
- 5,000 XPR sits in the testnet escrow from a transfer made while the old code was deployed
  (no confidential claim exists for it); harmless on testnet, and the reason `deposit` must
  never be a plain transfer in production (the notify handler asserts).

---

## 12. Mainnet readiness (what stands between the testnet build and real XPR)

The testnet build proves the mechanism. Three things make it unsafe for value today, in order of
severity:

1. **The ceremony is a rehearsal with one contributor (Paul's laptop).** Whoever holds that
   contribution's randomness can forge proofs and drain the escrow. Before any mainnet deployment:
   the published Hermez Powers-of-Tau (2^16 is enough; 46,874 constraints) plus a phase-2 with
   ≥ 5 independent contributors (Metallicus, ≥ 3 block producers, one external), published
   transcripts, verified with `snarkjs zkey verify`, and the resulting vk installed via `setvk`.
2. **No external audit** of the circuit, the contract, or the client library. The statement is
   small and standard (twisted ElGamal + range checks), which keeps the audit scope contained.
3. **Register has no proof of knowledge** of the encryption secret (v0). Harmless to others, but a
   Schnorr PoK should ship with the production contract.

Operational items: the contract account on mainnet must be allowed to `setcode` (XPR mainnet
gates contract deployment); RAM ≈ 280 KB for the contract plus ≈ 4 KB per config row and ≈ 700 B
per registered account; `withdraw_granularity` set to whole XPR (10,000 units) or coarser;
a real auditor key held in an HSM with the rotation procedure of §2.7; the wallet-side key
derivation moved into WebAuth (§2.7) rather than the dapp's localStorage.

A **mainnet demo with capped amounts** (e.g. `deposit_granularity` and a small max supply
enforced by a config field) is possible before the audit if Metallicus wants it, but not before
the ceremony: item 1 is the one that turns a demo into a theft.
