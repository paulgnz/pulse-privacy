#!/bin/sh
# Mainnet build: the same source with TESTNET=false, so the `reset` action is compiled out.
# Output: deploy/mainnet/xprshield.contract.{wasm,abi} and their sha256, for the runbook.
set -e
cd "$(dirname "$0")/.."
grep -q '^const TESTNET: bool = true;' assembly/xprshield.contract.ts || { echo "expected TESTNET=true in source"; exit 1; }
sed 's/^const TESTNET: bool = true;/const TESTNET: bool = false;/' assembly/xprshield.contract.ts > assembly/xprshield.mainnet.contract.ts
trap 'rm -f assembly/xprshield.mainnet.contract.ts' EXIT
npx proton-asc ./assembly/xprshield.mainnet.contract.ts --target release >/dev/null 2>&1
cp assembly/target/xprshield.mainnet.contract.wasm deploy/mainnet/xprshield.contract.wasm
cp assembly/target/xprshield.mainnet.contract.abi deploy/mainnet/xprshield.contract.abi
rm -f assembly/target/xprshield.mainnet.contract.*
shasum -a 256 deploy/mainnet/xprshield.contract.wasm deploy/mainnet/xprshield.contract.abi
