#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
mkdir -p "$root/.data/aqua-mcp-state"
export AQUA_ROOT="$root"
export AQUA_API_URL="https://vercel-henna-gamma-46.vercel.app"
export AQUA_RPC_URL="https://sepolia.gateway.tenderly.co"
export AQUA_CHAIN_ID="11155111"
export AQUA_RUNTIME_MANIFEST="${AQUA_RUNTIME_MANIFEST:-$root/.data/runtime-manifest.production.json}"
export XDG_STATE_HOME="$root/.data/aqua-mcp-state"
export AQUA_LEDGER="physical"
export AQUA_LEDGER_TRANSPORT="node-hid"
export AQUA_OAUTH_REUSE_CACHE=1
export AQUA_OAUTH_CALLBACK_PORT="${AQUA_OAUTH_CALLBACK_PORT:-41740}"
export PATH="$root/node_modules/.bin:${HOME}/.bun/bin:/nix/var/nix/profiles/default/bin:${HOME}/.nix-profile/bin:${PATH}"
export AQUA_WALLET_CLI="${AQUA_WALLET_CLI:-$root/node_modules/.bin/wallet-cli}"
pass_file="$root/.data/aqua-mcp-state/wallet-pass"
if [[ -z "${WALLET_PASS:-}" ]]; then
  if [[ -s "$pass_file" ]]; then
    WALLET_PASS="$(cat "$pass_file")"
  elif WALLET_PASS="$(security find-generic-password -w -s aqua-ledger-wallet-pass 2>/dev/null)"; then
    :
  else
    umask 077
    WALLET_PASS="$(openssl rand -hex 32)"
    printf '%s' "$WALLET_PASS" > "$pass_file"
    chmod 600 "$pass_file"
  fi
fi
export WALLET_PASS
exec bun "$root/apps/mcp-bridge/src/main.ts" --prod
