#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${AQUA_STATE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/aqua-check.XXXXXX")}"
mkdir -p "$artifact_dir"
report="$artifact_dir/report.json"
started="$(date +%s)"

test "$(grep -c '^[A-Z_][A-Z_]*=' .env.example)" -eq 2
! grep -R --exclude='.env' --exclude-dir='.git' --exclude-dir='bundle' --exclude-dir='dist' --exclude-dir='node_modules' --exclude-dir='.turbo' --exclude='aube-lock.yaml' -E 'PASETO_V4_SECRET_KEY|KEEPER_PRIVATE_KEY_FILE|AQUA_ADDRESS=' apps packages scripts >/dev/null
bun scripts/dependency-policy.ts
bun x tsc --noEmit
bun test
(cd contracts && forge test --offline)
nix flake check --no-build

jq -n \
  --arg system "$(sw_vers -productVersion 2>/dev/null || uname -sr)" \
  --arg arch "$(uname -m)" \
  --arg nix "$(nix --version)" \
  --arg bun "$(bun --version)" \
  --arg forge "$(forge --version | head -1)" \
  --argjson elapsed "$(( $(date +%s) - started ))" \
  '{status:"passed",system:$system,architecture:$arch,nix:$nix,bun:$bun,forge:$forge,elapsedSeconds:$elapsed,secrets:"redacted"}' > "$report"
echo "Local checks passed; report: $report"
