# ceremony-web — contribute to the trusted setup from a browser

Static Vite/React page plus Vercel functions; state and files in Vercel Blob. Contributors
connect a WebAuth account, take a 20-minute turn, download the current file, add randomness
(OS + pointer motion + a typed sentence), run the snarkjs contribution in a web worker, sign an
attestation with their account (the never-broadcast `xprconf::viewkey(owner, note)` with
`note = ceremony/<phase>/<index>/<output sha256>`), upload straight to Blob, and the server
records the contribution after re-hashing the file and recovering the signer key.

| piece | where |
|---|---|
| Vercel project | `pulse-privacy-ceremony` (team paulgnzs-projects), production https://pulse-privacy-ceremony.vercel.app |
| Blob store | `pulse-privacy-ceremony` (`store_IuzwDMO30XvPiahz`, syd1), connected to the project → `BLOB_READ_WRITE_TOKEN` |
| coordinator secret | `ADMIN_TOKEN` (project env + `.env.local`) for `POST /api/admin` |
| state | Blob `state/<version>-<time>.json` (append-only; latest by name); files `p1/NN-actor.ptau`, `p2/NN-actor.zkey` |

## API

- `GET /api/state` — public state (contributions without the signed transaction bodies).
- `GET /api/file/<pathname>` — redirect to the blob.
- `POST /api/lock` `{ actor }` — take the turn; `{ actor, release: true }` — give it back.
- `POST /api/upload-token` — `@vercel/blob/client` token handler; only the lock holder, only the expected path.
- `POST /api/contribute` `{ actor, permission, phase, index, inputSha256, outputSha256, contributionHash, signature }` — verifies and advances the head.
- `POST /api/admin` (header `x-admin-token`) — `{op:"release"}`, `{op:"finish"}`, `{op:"sethead", pathname, phase, name}`.

## Coordinator runbook

```sh
npm install && vercel env pull .env.local
node scripts/seed.mjs start                 # phase 1 start (done 2026-09-07: p1/00-start.ptau)
# … contributors take turns on the site …
# finalise phase 1 with the CLI: download the head file, then in ../ceremony:
#   node finalize.mjs phase1 <head.ptau> --beacon-block N   → final/pot16_final.ptau
#   node finalize.mjs setup ../circuits/build/transfer.r1cs   → contributions/00-setup.zkey
node scripts/seed.mjs head ../ceremony/contributions/00-setup.zkey p2/00-setup.zkey 2 "coordinator setup (no secret)"
# … contributors take turns again (phase 2) …
#   node finalize.mjs phase2 <head.zkey> --beacon-block M   → final/transfer_final.zkey, vk
curl -X POST https://pulse-privacy-ceremony.vercel.app/api/admin -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"op":"finish"}'
```

Verification for anyone: download every `output.url` from `/api/state` into `ceremony/contributions/`
with the attestation JSON (the same fields as the CLI writes), the finals into `ceremony/final/`,
and run `node ceremony/verify.mjs`.

## Not yet verified

A full contribution through a real WebAuth session in a browser (needs a wallet). Verified:
API state/lock/token guards on production, signature recovery unit test, and the in-memory
`powersOfTau.contribute` with the vendored snarkjs bundle on the seeded file (Node).
