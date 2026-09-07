# 05 — Independent review: handoff for Fable

Reviewed 2026-09-07 against commit `cf13819`, following all four briefs in
`docs/04-review-briefs.md` and checking findings against `docs/03-security-review.md`.

This records the Codex review from the conversation. Review was report-only: no fixes,
deployments, live wallet transactions, or live storage mutations were performed. This document
was subsequently added at the user's request. Findings describe that commit, not future changes.

**Result:** three high, three medium, and two low findings. The contract suite passed. No new
circuit theft or inflation exploit was found in this pass; that is not a security guarantee.

## Findings, ordered by severity

### 1. HIGH · CONFIRMED — Unauthenticated callers can delete the active contribution upload

**Location:** `ceremony-web/api/upload-token.ts:18` (checks and deletion through line 27).

An attacker supplies the publicly visible lock-holder's actor name. The handler authenticates
neither a signature nor the private lock token, then calls `del(pathname)` before issuing an
upload token. Expected: only the holder can retry. Actual: anyone knowing the current actor can
delete its active upload repeatedly and obstruct completion.

**Evidence:** executing the current handler with mocked storage returned HTTP 200 and deleted
`p1/01-alice.ptau` with no signature or lock token supplied. No live Blob request was made.

**Fix:** authenticate the private lock token; use unique immutable upload attempts and promote
only the verified attempt. Security-log item 8 remains incomplete. Earlier code granted
overwrite tokens; commits arriving during review changed this to deletion, which was retested.

### 2. HIGH · CONFIRMED — Incomplete ceremonies pass release verification

**Location:** `ceremony/verify.mjs:108`, especially lines 112–135.

A coordinator can omit final artifacts or beacon metadata, causing required checks to be
skipped. Expected: incomplete evidence fails verification. Actual: an empty contributions
directory with no final files prints **“ceremony verified”** and exits 0. Missing metadata also
disables the final-file linkage intended to prevent substitution (security-log item 5).

**Evidence:** ran the verifier in a temporary empty ceremony directory; observed exit 0.

**Fix:** release verification must require both phases, final artifacts, beacon metadata,
verifying key, and the required contributor count. Partial checks need a separate mode that
cannot claim a completed ceremony.

### 3. HIGH · CONFIRMED — Independent verification does not authenticate contributor identities

**Location:** `ceremony/verify.mjs:65` (signature checks through line 73).

A malicious coordinator can edit the claimed actor and signer metadata. The verifier compares
the recovered key with a `signerKey` in the same editable JSON, without checking account
authority or binding `actor` to the signed transaction. Signature checks are optional.

**Evidence:** generated a small real Powers-of-Tau contribution and a valid signature over a
transaction naming `alice`, but labelled the attestation `fakebank`. The verifier accepted it.
This reproduced identity-check failure; it was not a completed two-phase ceremony.

**Fix:** reconstruct the expected transaction, bind actor/phase/index/hash, and authenticate
identity against independently trusted account-key evidence or published attestations.

### 4. MEDIUM · CONFIRMED — Bundled folding restores the incoming-payment race

**Location:** `dapp/src/lib/client.ts:444` (`prepareSpend`, used by send and withdraw).

The app proves against a snapshot of `available + pending`, then broadcasts
`[applypending, send]`. An attacker credits the sender before execution; the fold includes the
extra credit, invalidating the proof. Expected: incoming credits cannot invalidate a prepared
spend. Actual: repeated credits can obstruct the app's payment flow.

**Evidence:** in the local contract simulator, a 0.0001 XPR deposit after proof generation
caused the bundled transaction to reject with `invalid proof`; its fold rolled back.

**Fix:** spend available funds when sufficient; otherwise confirm a separate fold before
taking the proof snapshot. Update the documented front-running claim.

### 5. MEDIUM · CONFIRMED — Confirmed activity can display forged amounts

**Location:** `dapp/src/lib/chain.ts:336`; `dapp/src/lib/client.ts:240`.

A malicious indexer retains a genuine transaction ID and counterparties but replaces the
ciphertext. Confirmation checks only the parties; displayed amounts still use indexer data.
Timeout handling also accepts unverified rows.

**Evidence:** mocked RPC/indexer responses changed a real 1 XPR payment to 999 XPR.
`confirmSend` returned true, and the substituted ciphertext decrypted to 999 XPR.

**Fix:** derive displayed sends from authenticated action data, including token and ciphertext,
with an action-specific identity. Label unavailable verification explicitly. Security-log
item 10 remains partially unresolved.

### 6. MEDIUM · CONFIRMED — Logout retains another account's confidential activity

**Location:** `dapp/src/App.tsx:257` (logout), line 269 onward (optimistic activity/timers).

A subsequent user of the same tab can see prior-session notifications and optimistic activity.
Logout clears keys and balances but leaves those states and scheduled refresh callbacks.

**Evidence:** a component-state reproduction using mocked React hooks invoked the actual
logout handler, then switched Alice to Bob. Alice's notification and transaction remained.
This was not a browser/WebAuth end-to-end test.

**Fix:** clear account-specific state, cancel timers, and prevent earlier-session responses
from updating the current session.

### 7. LOW · CONFIRMED BY SOURCE — Phase-2 transition omits required verification state

**Location:** `ceremony-web/scripts/seed.mjs:45`; `ceremony-web/api/contribute.ts:54`;
`ceremony-web/api/admin.ts:29`.

Following the documented `seed.mjs head … 2` command on a fresh ceremony never sets
`phase1Final`, so phase-2 submissions are rejected. The alternative admin path copies the
previous head rather than explicitly recording the finalized, prepared Powers-of-Tau file.

**Fix:** publish and validate the finalized phase-1 artifact explicitly during phase transition.
The complete live phase-2 workflow was not exercised.

### 8. LOW · CONFIRMED — Setup metadata is incorrectly treated as a contribution

**Location:** `ceremony/finalize.mjs:40`; `ceremony/verify.mjs:57`.

Finalization writes `00-setup.zkey.json`; verification includes it among phase-2 contributions
and requires the setup file to extend itself by one contribution. An honest setup therefore
fails this check.

**Evidence:** the existing zero-contribution setup's records checked against themselves return
`expected 1 contributions, found 0`, matching the verifier's iteration path.

**Fix:** distinguish setup records from participant attestations and validate them separately.

## Validation and handoff notes

- `npm test` in `contracts/xpr-conf-tsc` passed, including compressed-key handling,
  multi-token registration, canonical-point rejection, replay rejection, and withdrawal.
- Additional local checks accepted an unnormalised low chunk crossing 32 bits; rejected
  altered nonce, sender, receiver, remainder, and auditor handle; and decrypted values
  `4294967295` and `4294967305` correctly with the browser arithmetic implementation.
- Targeted reproductions used temporary artifacts or in-memory source loading/mocks.
  No permanent reproduction scripts were added; the evidence above records their outcomes.
- Fable should independently reproduce each finding, check intervening commits, and reconcile
  fixes with `docs/03-security-review.md`. Start with ceremony findings 1–3. Retain regression
  tests when implementing fixes, and exercise a complete two-phase ceremony before relying on
  its verification result.
