#!/usr/bin/env bash
# Compile every Noir circuit, write its verification key, and generate its Solidity
# verifier. Toolchain pin (verified pair, see zk/README.md "Toolchain"):
#   nargo 1.0.0-beta.25  +  bb 5.2.1   (bb v5.2.1's noir submodule == noir v1.0.0-beta.25)
set -euo pipefail
export PATH="$HOME/.bb:$HOME/.nargo/bin:$PATH"
ZK="$(cd "$(dirname "$0")/.." && pwd)"
CIRCUITS="$ZK/circuits"
OUT_SOL="$ZK/contracts/src/verifiers"
OUT_ART="$ZK/client/artifacts"
mkdir -p "$OUT_SOL" "$OUT_ART"

want_nargo="1.0.0-beta.25"; want_bb="5.2.1"
nargo --version | grep -q "nargo version = $want_nargo" || { echo "need nargo $want_nargo (noirup -v $want_nargo)"; exit 1; }
[ "$(bb --version)" = "$want_bb" ] || { echo "need bb $want_bb (bbup -v $want_bb)"; exit 1; }

cd "$CIRCUITS"
nargo compile --workspace --silence-warnings

# circuit name -> Solidity contract name prefix
declare -A NAMES=(
  [transact]=Transact [policy_pay]=PolicyPay [budget_init]=BudgetInit [ragequit]=Ragequit
  [m0_commitment]=M0Commitment [m0_merkle]=M0Merkle
)
for c in "${!NAMES[@]}"; do
  n="${NAMES[$c]}"
  mkdir -p "target/$c"
  # -t evm: keccak Fiat-Shamir transcript (cheap to verify in the EVM) WITH zero-knowledge
  # masking. Never use evm-no-zk here: without ZK, a proof can leak witness information.
  # --optimized: bb's assembly verifier. Measured on our transact proof: 669,785 gas vs
  # 2,183,380 for the default verifier, 16.7 KB, no external libraries to link. The full
  # tamper battery in contracts/test/Verifiers.t.sol runs against it.
  bb write_vk -b "target/$c.json" -o "target/$c" -t evm >/dev/null
  bb write_solidity_verifier -k "target/$c/vk" -o "target/$c/Verifier.sol" -t evm --optimized >/dev/null
  # Every generated verifier declares the same top-level names; prefix them so all
  # verifiers can live in one Foundry project.
  python3 "$ZK/scripts/rename_verifier.py" "target/$c/Verifier.sol" "$n" > "$OUT_SOL/${n}Verifier.sol"
  cp "target/$c.json" "$OUT_ART/$c.json"
  cp "target/$c/vk" "$OUT_ART/$c.vk"
  echo "built $c -> ${n}Verifier.sol ($(bb gates -b target/$c.json | grep -o '"circuit_size": [0-9]*'))"
done
