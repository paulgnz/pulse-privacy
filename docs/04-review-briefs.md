# 04 — Independent review briefs

Paste one brief at a time into an independent reviewer (a different model or a person), from a
checkout of this repository. Each brief is self-contained. Findings that are already listed as
fixed or accepted in [03-security-review.md](03-security-review.md) do not need re-reporting,
but a reviewer who disagrees with an "accepted" item should say so.

Common preamble for every brief:

> You are doing an adversarial security review. Do not edit files; report only. Read the files
> listed in full before forming a view. Be skeptical of your own findings: re-read the surrounding
> code to confirm a bug before reporting it. Report a numbered list ordered by severity
> (critical, high, medium, low, informational). For each item give a title, file and line,
> what an attacker does, expected versus actual behaviour, and a proposed fix, and mark it
> CONFIRMED or NEEDS-TEST. First read docs/03-security-review.md so you do not re-report what
> is fixed; if you think an accepted risk is wrong to accept, say why. Keep the report under
> 1,000 words.

---

## Brief 1: the contract

Read fully: `contracts/xpr-conf-tsc/assembly/xprconf.contract.ts`, `assembly/babyjub.ts`,
`assembly/groth16.ts`, `assembly/consts.ts`, and the tests in `contracts/xpr-conf-tsc/tests/`.
Background: `docs/01-design.md` sections 2, 4 and 7.

Context: an Antelope (XPR Network) contract in proton-tsc (AssemblyScript) that holds XPR and
XMD in escrow and stores per-account encrypted balances (twisted ElGamal on Baby Jubjub, two
32-bit chunks), an available box and a pending box, and a nonce. `send` and `withdraw` verify
Groth16 proofs on bn254 through the chain's `alt_bn128_add`, `alt_bn128_mul`, `alt_bn128_pair`
and `mod_exp` intrinsics. Deposits arrive by token transfer notification with memo
`conf:<owner>`. `applypending` folds pending into available. `register` publishes a key;
`ensureAccount` creates a row for a second token from a key registered for another.

Try to break it:
1. Move value without a valid proof, or reuse a proof across accounts, tokens, nonces, or after a fold. Check exactly which public inputs the proof is bound to and whether any is missing or attacker-controlled.
2. Manipulate the receiver's pending box so a later fold or send fails or credits the wrong amount.
3. The deposit path: memo parsing, a same-symbol token from another contract, zero or negative quantity, paused state, the limits counters and their overflow.
4. The withdraw path: is the public amount bound to the proof; granularity; pool counter underflow; token contract used for the payout.
5. Authority on every admin action; RAM billing through `ensureAccount`; key overwrite through `register`.
6. Point handling: on-curve and canonical checks (added on 2026-09-07), identity and low-order points, malformed proofs or inputs that make the intrinsics succeed incorrectly, 64-bit overflow in amounts.
7. Anything that lets an attacker steal, freeze or inflate funds, or make the auditor unable to read a payment.

---

## Brief 2: the circuit and client cryptography

Read fully: `circuits/transfer/transfer.circom` and the circomlib templates it instantiates,
`circuits/lib/elgamal.mjs`, `circuits/lib/encode.mjs`, `circuits/test/*.mjs`,
`dapp/src/lib/crypto/real.ts`, `dapp/src/lib/crypto/babyjub.ts`. Background: `docs/01-design.md`
sections 2.2 to 2.8.

Context: balances are twisted ElGamal ciphertexts on Baby Jubjub with P = s⁻¹·H, C = v·G + r·H,
D = r·P; 64-bit amounts split into two 32-bit chunks; one Groth16 proof per transfer
(circom 2.2, snarkjs 0.7, 46,874 constraints, 41 public inputs) proves the old balance decrypts
to v_old, v ≤ v_old, v in range, and that the sender's new box, the receiver's box and the
auditor's box all encrypt the same chunks, bound to sender and receiver names and a nonce.
Withdrawals reuse the circuit with the transfer randomness set to zero so the amount is public.

Try to break it:
1. Soundness: list every constraint the statement needs and confirm it is enforced with `===`, not merely computed. Look for under-constrained signals, missing range checks, borrow handling across chunks, missing equality between the three ciphertexts, missing binding of public inputs.
2. Curve handling inside the circuit: on-curve, subgroup and small-order points for the receiver and auditor keys; can a sender craft keys or randomness that make a box undecryptable or ambiguous.
3. Chunk overflow when many payments accumulate in the pending low chunk; BSGS decryption at the top of the range.
4. Withdrawal with zero transfer randomness: leakage or forgeability.
5. Client side: randomness sources, secret handling, anything that could leak an amount or a secret to a log, URL, storage or network call; serialisation mismatches against the contract.
6. Trusted-setup artefacts in `circuits/build` and `dapp/public/circuit`: what a malicious proving key could do and whether the client checks it against the on-chain verifying key.

---

## Brief 3: the web app's keys and wallet flow

Read fully, under `dapp/`: `src/lib/unlock.ts`, `src/lib/keys.ts`, `src/lib/chain.ts`,
`src/lib/client.ts`, `src/components/Onboarding.tsx`, `src/components/Settings.tsx`,
`src/components/Auditor.tsx`, `src/App.tsx`, `src/lib/stats.ts`, `vercel.json`, `index.html`.
Background: `docs/01-design.md` sections 6 and 11.

Context: the user's encryption secret is derived from a WebAuth wallet signature over a fixed,
never-broadcast transaction `xprconf::viewkey(owner, note)`. For K1 keys the signature is
deterministic, so the key is re-derived each session and never stored; for other signers the
app creates a saved key in localStorage with an export step. Proofs are built in the browser
with snarkjs and broadcast through the wallet. The auditor page accepts a pasted viewing key.

Try to break it:
1. Key derivation: what is signed and hashed; can another origin obtain the same signature; is the secret reduced correctly into the scalar field; where the secret lives and whether sign-out clears it.
2. The deterministic-signature assumption for K1 keys and the failure mode if it is wrong.
3. Saved keys: exposure, export contents, import validation.
4. Anything the site could get a user to sign that moves funds unexpectedly; whether the never-broadcast transaction can ever be broadcast.
5. Trust in RPC and Hyperion data: wrong balances, spoofed activity or registration state, injection through the `?to=` and `?token=` parameters, any `innerHTML`.
6. The auditor page: does the key ever leave the browser; can a wrong key decrypt silently.
7. Headers, the content security policy, third-party scripts, analytics payloads.

---

## Brief 4: the trusted-setup ceremony

Read fully: `ceremony-web/src/App.tsx`, `ceremony-web/src/worker.ts`, `ceremony-web/src/lib/*.ts`,
everything under `ceremony-web/api/`, `ceremony-web/README.md`, and `ceremony/contribute.mjs`,
`ceremony/verify.mjs`, `ceremony/finalize.mjs`, `ceremony/lib/chain.mjs`, `ceremony/README.md`.
Background: `docs/01-design.md` section 2.8 and `docs/02-mainnet-runbook.md` section 3.

Context: contributors connect a WebAuth wallet, sign a timestamped note to take a 20-minute
turn, download the current file, mix in randomness in a web worker, sign an attestation whose
note is `ceremony/<phase>/<index>/<sha256>`, upload the output to Vercel Blob with a client
token, and POST `/api/contribute`. The server checks that the upload carries every earlier
contribution unchanged plus one new one, runs snarkjs verification, verifies the signature
against the account's keys, and advances the head. State lives in Blob as fixed-name versions
with overwriting refused. The final key comes from `finalize.mjs` with an XPR block id beacon
confirmed by several RPCs, and `verify.mjs` recomputes the beacon step.

Try to break it:
1. Replace, skip or reorder a contribution; take or hold the lock unfairly; race two contributors; make the recorded state diverge from the files.
2. Coordinator or Blob-token holder substituting files or state, and whether `verify.mjs` would catch it. What does `verify.mjs` not prove?
3. Randomness: is it actually used, and could the served bundle exfiltrate or fix it; what a contributor can do to detect a tampered bundle.
4. The attestation and lock signatures: replay across index, phase, file, or time; the key set checked against.
5. The upload token, the admin endpoint, and the beacon.
6. Anything that lets a single party know all randomness or make the transcript unverifiable.
