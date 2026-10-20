#!/usr/bin/env bash
# Build the recursive aggregation circuits (circuits/aggregate_{2,4,8}, see docs/aggregation.md):
# compile, check that the child verification-key hashes pinned in circuits/agg match what bb
# computes, and generate one EVM verifier per tree root. Separate from build-circuits.sh so the
# existing circuits' EVM targets and verifiers are untouched.
#
# Each circuit has two verification keys:
#   -t noir-recursive  (Poseidon2 transcript) for when it is a child inside the next level;
#                      its hash is what the parent pins
#   -t evm             (keccak transcript) for when it is the root, verified by the pool
set -euo pipefail
export PATH="$HOME/.bb:$HOME/.nargo/bin:$PATH"
ZK="$(cd "$(dirname "$0")/.." && pwd)"
CIRCUITS="$ZK/circuits"
OUT_SOL="$ZK/contracts/src/verifiers"
OUT_ART="$ZK/client/artifacts"

want_nargo="1.0.0-beta.25"; want_bb="5.2.1"
nargo --version | grep -q "nargo version = $want_nargo" || { echo "need nargo $want_nargo (noirup -v $want_nargo)"; exit 1; }
[ "$(bb --version)" = "$want_bb" ] || { echo "need bb $want_bb (bbup -v $want_bb)"; exit 1; }

cd "$CIRCUITS"
hex() { xxd -p -c32 "$1"; }
pinned() { grep -o "pub global $1: Field = 0x[0-9a-f]*" agg/src/lib.nr | grep -o '0x[0-9a-f]*$' | cut -c3-; }

# the leaves pin transact's recursion vk
nargo compile --package transact --silence-warnings
mkdir -p target/transact_rec
bb write_vk -b target/transact.json -o target/transact_rec -t noir-recursive >/dev/null
[ "$(hex target/transact_rec/vk_hash)" = "$(pinned TRANSACT_VK_HASH)" ] \
  || { echo "TRANSACT_VK_HASH in agg/src/lib.nr is stale: set it to 0x$(hex target/transact_rec/vk_hash)"; exit 1; }
# client artifacts: .rvk = recursion vk (+ .rvk_hash), .vk = EVM vk (roots only)
cp target/transact_rec/vk "$OUT_ART/transact.rvk"
cp target/transact_rec/vk_hash "$OUT_ART/transact.rvk_hash"

for n in 2 4 8; do
  c="aggregate_$n"
  nargo compile --package "$c" --silence-warnings
  mkdir -p "target/${c}_rec" "target/$c"
  bb write_vk -b "target/$c.json" -o "target/${c}_rec" -t noir-recursive >/dev/null
  if [ "$n" != 8 ]; then
    up="AGGREGATE_${n}_VK_HASH"
    [ "$(hex "target/${c}_rec/vk_hash")" = "$(pinned "$up")" ] \
      || { echo "$up in agg/src/lib.nr is stale: set it to 0x$(hex "target/${c}_rec/vk_hash") and rerun"; exit 1; }
  fi
  # -t evm: keccak transcript WITH zero-knowledge masking, --optimized assembly verifier
  # (same choices as build-circuits.sh)
  bb write_vk -b "target/$c.json" -o "target/$c" -t evm >/dev/null
  bb write_solidity_verifier -k "target/$c/vk" -o "target/$c/Verifier.sol" -t evm --optimized >/dev/null
  python3 "$ZK/scripts/rename_verifier.py" "target/$c/Verifier.sol" "Aggregate$n" \
    | sed 's#zk/scripts/build-circuits.sh#zk/scripts/build-aggregates.sh#' > "$OUT_SOL/Aggregate${n}Verifier.sol"
  cp "target/$c.json" "$OUT_ART/$c.json"
  cp "target/${c}_rec/vk" "$OUT_ART/$c.rvk"
  cp "target/${c}_rec/vk_hash" "$OUT_ART/$c.rvk_hash"
  cp "target/$c/vk" "$OUT_ART/$c.vk"
  echo "built $c -> Aggregate${n}Verifier.sol ($(bb gates -b "target/$c.json" | grep -o '"circuit_size": [0-9]*'))"
done
