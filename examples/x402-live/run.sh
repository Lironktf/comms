#!/usr/bin/env bash
# One-command runner for the live x402 + ACTP demo on Base Sepolia.
#   ./run.sh           run the ALLOW path (pays the verified merchant on-chain)  [needs funding]
#   ./run.sh --rogue   run the DENY path  (blocked before signing)               [no funding needed]
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
LOG=/tmp/actp-x402-demo
mkdir -p "$LOG"

cleanup() { kill "${ACTP_PID:-}" "${SELLER_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT

echo "▶ starting ACTP decision server…"
"$TSX" actp-serve.ts > "$LOG/actp.log" 2>&1 &
ACTP_PID=$!
echo "▶ starting x402 seller…"
"$TSX" seller.ts > "$LOG/seller.log" 2>&1 &
SELLER_PID=$!

# wait for both to be listening
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1 && \
  curl -s http://127.0.0.1:4021/report >/dev/null 2>&1 && break
  sleep 0.5
done
sed -n '1,20p' "$LOG/actp.log"

echo "▶ running payer…"
"$TSX" pay.ts "$@"
