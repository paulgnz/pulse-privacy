# auditor-cli (T5)

With the auditor viewing key, reads every confidential transfer from history, decrypts the
amounts, and reconciles the pool. Reuses `circuits/lib/elgamal.mjs` (run `npm install` in
`circuits/` first). No chain writes; nothing leaves the machine except public RPC/Hyperion reads.

```sh
node auditor.mjs ledger            # every send (decrypted), deposit, withdraw, register
node auditor.mjs account paul123   # one account's history
node auditor.mjs reconcile         # per-account balances reconstructed from the ledger,
                                   # Σ vs deposits − withdrawals vs escrow; exit 2 on mismatch
```

Key: `AUDITOR_SECRET=<scalar>` or `AUDITOR_KEYFILE=<json with {"auditor": ...}>`; defaults to the
testnet key file in `contracts/xpr-conf-tsc/tests/`. Endpoints via `HYPERION`, `RPC`,
`CONTRACT`, `SYMBOL`, `PRECISION`.

What the auditor can and cannot see: every **transfer amount** (the auditor handle is proven
into every `send`), every deposit and withdrawal (public). It cannot open **balance**
ciphertexts (those carry only the owner's handle), so balances are reconstructed by summation,
which is exactly what a supervisor's ledger needs and what `reconcile` checks against the
on-chain nonces and the escrow. "Stray transfers in" are token transfers to the contract without
a `conf:` memo (none can exist once the notify handler asserts; the testnet has one from before
the contract code was live).
