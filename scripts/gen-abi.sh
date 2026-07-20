#!/usr/bin/env bash
# Regenerates packages/core/src/abi.ts from Foundry build artifacts.
set -euo pipefail
cd "$(dirname "$0")/.."

(cd contracts && forge build --silent)

{
  echo "// Auto-generated from Foundry artifacts — do not edit by hand."
  echo "// Regenerate: npm run gen:abi (scripts/gen-abi.sh)"
  echo "export const vendorRegistryAbi = $(jq -c .abi contracts/out/VendorRegistry.sol/VendorRegistry.json) as const;"
  echo ""
  echo "export const attestationRegistryAbi = $(jq -c .abi contracts/out/AttestationRegistry.sol/AttestationRegistry.json) as const;"
} > packages/core/src/abi.ts

echo "wrote packages/core/src/abi.ts"
