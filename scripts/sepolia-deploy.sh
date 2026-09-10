#!/usr/bin/env bash
set -euo pipefail

root="${AQUA_ROOT:-$PWD}"
if [[ -f "$root/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$root/.env"
  set +a
fi

: "${AQUA_SEPOLIA_RPC_URL:?Set AQUA_SEPOLIA_RPC_URL to an Ethereum Sepolia JSON-RPC endpoint}"
: "${AQUA_SEPOLIA_PRIVATE_KEY:?Set AQUA_SEPOLIA_PRIVATE_KEY to a funded Sepolia deployer key (not the Anvil demo key)}"
: "${AQUA_UPSTREAM:?Run this from nix develop so Aqua/SwapVM/x402/Permit2 sources are set}"
: "${SWAPVM_UPSTREAM:?}"
: "${X402_UPSTREAM:?}"
: "${PERMIT2_UPSTREAM:?}"

export AQUA_ROOT="$root"
export AQUA_STATE_DIR="${AQUA_SEPOLIA_STATE_DIR:-$root/.data/sepolia}"
mkdir -p "$AQUA_STATE_DIR"

if [[ ! -f "$AQUA_STATE_DIR/identity.json" && -f "$root/.data/identity.json" ]]; then
  cp "$root/.data/identity.json" "$AQUA_STATE_DIR/identity.json"
fi
if [[ ! -f "$AQUA_STATE_DIR/identity.json" ]]; then
  echo "Missing $AQUA_STATE_DIR/identity.json. Run nix develop -c dev-emulated (or ledger-bootstrap) once, then retry." >&2
  exit 1
fi

export AQUA_BROKER_SOCKET="${AQUA_BROKER_SOCKET:-$AQUA_STATE_DIR/secret-broker.sock}"
export AQUA_API_PORT="${AQUA_API_PORT:-8787}"
export AQUA_FACILITATOR_PORT="${AQUA_FACILITATOR_PORT:-8788}"
export DATABASE_URL="${DATABASE_URL:-postgresql://aqua:aqua@127.0.0.1:5432/aqua_backend}"

public_rpc="$AQUA_SEPOLIA_RPC_URL"

bun "$root/scripts/deploy-sepolia.ts"
bun "$root/scripts/generate-local-manifest.ts" \
  --profile sepolia \
  --rpc-url "${AQUA_SEPOLIA_VERIFY_RPC_URL:-$public_rpc}" \
  --deployments "$AQUA_STATE_DIR/deployments.json" \
  --out "$AQUA_STATE_DIR/runtime-manifest.json"

echo "Wrote $AQUA_STATE_DIR/runtime-manifest.json"
echo "Keep Anvil stopped. Point workers at this manifest, for example:"
echo "  bun apps/api/src/main.ts --config $AQUA_STATE_DIR/runtime-manifest.json"
