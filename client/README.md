# Private XPR headless client

The whole product from a terminal: no browser, no wallet popup. Useful for merchants, bots,
treasuries and the committee. It uses the same contract, the same circuit files and the same
defences as the app.

## Setup

```sh
npm ci --prefix circuits          # the note library's dependencies (snarkjs, circomlibjs)
npm i -g @proton/cli              # signing: the account's XPR key lives in the proton CLI keychain
proton key:add                    # once per signing key
node client/privatexpr.mjs        # prints the command list
```

Nothing in this client ever reads or prints an XPR private key. Chain writes are handed to the
`proton` CLI, which signs from its own encrypted keychain. The Private XPR key (the one that
reads notes and builds proofs; it cannot spend without the account's signature) is kept in
`~/.private-xpr/<network>/<account>.json`, mode 600. `PRIVATEXPR_HOME` moves that directory.
Recovery phrases are never accepted on the command line, because shells keep history and process
listings are public on a shared machine; the client asks at a hidden prompt or reads standard input.
Signing takes a lock at `~/.privatexpr-signing.lock` while it switches the proton CLI's chain, since
that setting is shared by every process of the user. The lock records its owner's process id; a lock
whose owner is no longer running is reclaimed, and a live owner's lock is never taken, however old.

## A first run on testnet

```sh
C="node client/privatexpr.mjs"
$C keys new myaccount             # or: keys import myaccount <secret or key file from the app>
$C register myaccount             # one signature; once per account
$C deposit myaccount 25           # 25 XPR: transfer with the note memo, then placed as a note
$C balance myaccount
$C send myaccount someone 10      # someone must be registered; the chain sees only that you paid
$C withdraw myaccount 5           # to your own public balance
$C activity myaccount
$C backup phrase myaccount        # prints seven words once; stores the encrypted copy on chain (--own: type your own at a hidden prompt)
$C backup committee myaccount     # a copy only the committee's key opens
$C restore myaccount               # asks for the seven words at a hidden prompt (or reads them from stdin)
```

`--network mainnet` (or `PRIVATEXPR_NETWORK=mainnet`) targets the mainnet contract once it is
live. `XMD` as the last argument of `deposit`, `send` and `withdraw` uses the Metal Dollar.

## What it checks before believing a node

The same as the app: the contract's configuration and the tree root must be agreed by two nodes
and the auditor key must equal the one pinned for the network; each node's outputs are checked
against that root on their own; the note data beside the commitments is agreed by vote; a spend
tag counts when two nodes list it. Anything less shows the balance as unconfirmed, and `send`
and `withdraw` refuse to act on it unless `--force` is given. History is only believed after a
chain node's block confirms the transaction.

## The committee

```sh
PRIVATEXPR_AUDITOR_KEY=/path/to/auditor-key.json node client/privatexpr.mjs audit
PRIVATEXPR_AUDITOR_KEY=/path/to/auditor-key.json node client/privatexpr.mjs recover someaccount
```

`audit` opens every note with the committee's key and names payer and receiver. `recover`
opens an account's committee copy, checks it against the registration, and prints the key file
to hand to the owner after they have proved they own the account.

## Limits

One payment spends at most two notes; if your balance is spread across many small notes, pay
yourself the total first. Proving takes about two seconds on a laptop. The circuit files are
read from `dapp/public/circuit/` (`PRIVATEXPR_CIRCUIT_DIR` overrides); they must match the
verifying key on the contract, which they do for the current revision.
