#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "physical Ledger acceptance requires aarch64-darwin" >&2
  exit 1
fi
for tool in bun node yarn make jq forge anvil cast psql process-compose wallet-cli security; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done
if pgrep -x "Ledger Live" >/dev/null; then
  echo "quit Ledger Live before using the HID device" >&2
  exit 1
fi
security find-generic-password -s aqua-ledger-wallet-pass >/dev/null
wallet-cli genuine-check --output json
wallet-cli account discover --currency ethereum --output json
echo "Ledger/macOS preflight passed"
