# Headless checks for the dapp

Playwright scripts that drive the built app the way a user would. They are what the work in
`docs/06` was verified with; run them after changes to the private (v2) flows.

Prerequisites: two dev servers, `npm run dev` on port 5175 with `VITE_CRYPTO=mock` (simulated
sessions via `?demo=<account>`, real testnet reads) and on 5176 with real crypto; Playwright
installed somewhere (`PLAYWRIGHT_PKG=/path/to/a/package.json` that has it as a dependency, or
install it in `dapp/`); the testnet demo keys at `contracts/xpr-shield-tsc/tests/.testnet-shield-keys.json`
(gitignored; `node tests/testnet-demo.mjs keys` makes new ones, but the accounts on testnet are
registered with the existing ones). `E2E_OUT` is where screenshots go (default `/tmp`).

| script | what it checks |
|---|---|
| `shield-recovery-ui.mjs` | passkey onboarding: recovery phrase step, register screen; restore from the phrase copy on chain, wrong phrase refused; Settings statuses; restore from the key file |
| `shield-setup.mjs` | the setup progress bar for signed-out, returning and new accounts |
| `shield-mismatch.mjs` | a saved key that is not the registered one is set aside |
| `shield-tabs.mjs` | Statement, Activity, Auditor (ledger opened with the auditor key), Settings |
| `shield-activity.mjs` | the Activity timeline: deposited, received from, sent (change), withdrew |
| `shield-home.mjs`, `shield-old.mjs` | v2 at `/`, the old contract at `/old` withdraw-only, header links |
| `shield-about2.mjs`, `shield-wt.mjs` | How it works on desktop and mobile; the walkthrough steps |
| `shield-browser2.mjs` | a proof built in the browser verifies against the circuit's key with the 27 words the contract assembles, and fails for another signer |
| `shield-blobs.mjs`, `shield-scan-paul.mjs` | recovery copies round-trip; the scan sees a given account's notes |
| `shield-popup.mjs` | a blocked wallet window fails fast; recipient suggestions |
| `live-check.mjs` | the deployed sites: brand, heading, header links |
| `bad-node.mjs` | one node's outputs poisoned (duplicate row, wrong commitment): the scan still completes from the healthy nodes (run against the preview build, port 5179) |
| `lying-node.mjs` | the review series distilled: forged output rows do not change the balance, a forged payer and a forged withdrawal are not shown in Activity, a swapped auditor key stops the app, Forget leaves nothing behind (preview build, port 5179; exits non-zero on any failure) |

Note: in the Vite dev server, React 19's development-only performance tracing serialises component
props and throws on BigInt values during slow renders ("Do not know how to serialize a BigInt",
then "Should not already be working"). Production builds do not include that tracing. For the
Activity and Auditor checks, run against a preview of a mock build instead:
`VITE_CRYPTO=mock VITE_NETWORK=testnet npx vite build --outDir dist-mock && npx vite preview --outDir dist-mock --port 5179`,
and point the script at port 5179.

