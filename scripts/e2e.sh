#!/usr/bin/env bash
set -euo pipefail

mode="${1:-deterministic}"
shift || true
root="$(git rev-parse --show-toplevel)"
physical=0
if [[ "$mode" == physical ]]; then physical=1; fi

if [[ "$mode" == bazantic-canary ]]; then
  export AQUA_E2E_REPORT="${AQUA_E2E_REPORT:-$root/reports/e2e/bazantic-canary.json}"
  exec bun "$root/test/e2e/bazantic-canary.ts" "$@"
fi

if [[ "$physical" == 1 ]]; then
  export AQUA_E2E_PHYSICAL=1
  export AQUA_LEDGER_TRANSPORT=node-hid
  echo "Physical Ledger mode: confirm every on-device review screen. Speculos is not used." >&2
elif [[ "$(uname -s)" == Darwin && "${AQUA_E2E_INNER:-0}" != 1 ]]; then
  command -v docker >/dev/null || { echo "Docker is required for the Linux Speculos E2E environment" >&2; exit 1; }
  uid="$(id -u)"
  gid="$(id -g)"
  docker build -t aqua-speculos-e2e --build-arg "UID=$uid" --build-arg "GID=$gid" -f "$root/Dockerfile" "$root"
  exec docker run --rm --platform linux/arm64 --privileged -e AQUA_E2E_INNER=1 \
    -e AQUA_BAZANTIC_GATEWAY_SLUG="${AQUA_BAZANTIC_GATEWAY_SLUG:-}" \
    -e "AQUA_UID=$uid" -e "AQUA_GID=$gid" \
    -v aqua-speculos-nix-store:/nix \
    -v aqua-speculos-aube-cache:/home/aqua/.cache/aube \
    -v aqua-speculos-aube-store:/home/aqua/.local/share/aube \
    -v "$root:/workspace" -w /workspace \
    -v aqua-speculos-node-modules:/workspace/node_modules \
    aqua-speculos-e2e e2e "$mode" "$@"
fi

if [[ "$physical" != 1 ]]; then
  if [[ "$(uname -s)" != Linux ]]; then
    echo "Speculos E2E inner runner requires Linux" >&2
    exit 1
  fi
  if [[ -z "${AQUA_LEDGER_E2E_ASSETS:-}" || -z "${AQUA_SPECULOS_BIN:-}" ]]; then
    echo "Run through nix develop so the pinned Ledger ELFs and Speculos executable are available" >&2
    exit 1
  fi
fi
if [[ -z "${AQUA_PYTHON:-}" ]]; then
  echo "AQUA_PYTHON is required for FIDO2 CTAP" >&2
  exit 1
fi

export AQUA_E2E=1
work="$(mktemp -d "${TMPDIR:-/tmp}/aqua-e2e.XXXXXX")"
processes=()
cleanup() {
  for pid in "${processes[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
mkdir -p "$root/reports/e2e" "$work/speculos" "$work/state"

start_speculos() {
  local app="$1"
  local keep_alive="${2:-0}"
  local api_port="${3:-5000}"
  local elf="$AQUA_LEDGER_E2E_ASSETS/apps/$app.elf"
  local probe_apdu probe_expect probe_name
  local speculos_args=(--model nanosp --display headless --api-port "$api_port" --apdu-port 9999)
  case "$app" in
    ledger-sync) probe_apdu=e004000000; probe_expect=4c65646765722053796e63; probe_name=get-app-name ;;
    ethereum) probe_apdu=e006000000; probe_expect=9000; probe_name=get-app-configuration ;;
    security-key)
      probe_apdu=""; probe_expect=""; probe_name=ctaphid-u2f
      speculos_args=(--model nanosp --display headless --api-port "$api_port" --apdu-port 5001 --usb U2F)
      ;;
    *) echo "Unknown Ledger E2E app: $app" >&2; exit 1 ;;
  esac
  "$AQUA_SPECULOS_BIN" "${speculos_args[@]}" \
    --seed "glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin" \
    "$elf" >"$work/speculos/$app.log" 2>&1 &
  local pid=$!
  processes+=("$pid")
  local ready=0
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$api_port/events" >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.25
  done
  if [[ "$ready" != 1 ]]; then
    echo "Speculos failed to start the $app app" >&2
    head -n 200 "$work/speculos/$app.log" >&2 || true
    exit 1
  fi
  if [[ "$app" == ethereum && "$physical" != 1 ]]; then
    curl -fsS -X POST "http://127.0.0.1:$api_port/automation" -H "content-type: application/json" \
      --data-binary @"$root/test/e2e/ethereum-automation.json" >/dev/null
  fi
  if [[ "$app" == security-key && "$physical" != 1 ]]; then
    curl -fsS -X POST "http://127.0.0.1:$api_port/automation" -H "content-type: application/json" \
      --data-binary @"$root/test/e2e/security-key-automation.json" >/dev/null
  fi
  AQUA_SPECULOS_APP="$app" AQUA_SPECULOS_ELF="$elf" AQUA_SPECULOS_EVIDENCE="$root/reports/e2e/speculos-$app.json" \
    AQUA_SPECULOS_PROBE_APDU="$probe_apdu" AQUA_SPECULOS_PROBE_EXPECT="$probe_expect" AQUA_SPECULOS_PROBE_NAME="$probe_name" \
    AQUA_SPECULOS_URL="http://127.0.0.1:$api_port" \
    bun "$root/test/e2e/speculos-smoke.ts"
  if [[ "$app" == ethereum ]]; then
    export AQUA_LEDGER_TRANSPORT=speculos
    export AQUA_SPECULOS_URL="http://127.0.0.1:$api_port"
    bun "$root/test/e2e/ethereum-enable-blind-signing.ts"
    if ! AQUA_E2E_REPORT="$root/reports/e2e/ethereum-owner.json" bun "$root/test/e2e/ethereum-owner.ts"; then
      echo "Ethereum owner SIWE or EIP-712 step failed; Speculos screen and logs follow" >&2
      curl -sS "http://127.0.0.1:$api_port/events?currentscreenonly=true" >&2 || true
      head -n 200 "$work/speculos/$app.log" >&2 || true
      exit 1
    fi
  fi
  if [[ "$app" == security-key ]]; then
    export AQUA_SECURITY_KEY_SPECULOS_URL="http://127.0.0.1:$api_port"
    export AQUA_SECURITY_KEY_HID_PORT=5001
    [[ -n "${AQUA_PYTHON:-}" ]] || { echo "AQUA_PYTHON is required for the security-key CTAPHID probe" >&2; exit 1; }
    AQUA_E2E_REPORT="$root/reports/e2e/security-key-ctap.json" "$AQUA_PYTHON" "$root/test/e2e/security-key-ctap.py"
  fi
  if [[ "$app" == ledger-sync ]]; then
    export AQUA_E2E_LKRP_STATE="$work/lkrp"
    export AQUA_SPECULOS_URL=http://127.0.0.1:5000
    WALLET_PASS="$(openssl rand -hex 32)"
    export WALLET_PASS
    local adapter="$root/test/e2e/wallet-cli-adapter.ts"
    "$adapter" ring init --output json >"$work/lkrp-init.json"
    printf 'key-ring-round-trip' | "$adapter" ring encrypt --key evidence -o "$work/lkrp.enc" --output json >"$work/lkrp-encrypt.json"
    local decrypted
    decrypted="$("$adapter" ring decrypt --key evidence -i "$work/lkrp.enc")"
    [[ "$decrypted" == key-ring-round-trip ]] || { echo "LKRP adapter round trip failed" >&2; exit 1; }
    cp "$work/lkrp.enc" "$work/lkrp-tampered.enc"
    printf '\001' >>"$work/lkrp-tampered.enc"
    if "$adapter" ring decrypt --key evidence -i "$work/lkrp-tampered.enc" >/dev/null 2>&1; then
      echo "LKRP adapter accepted tampered ciphertext" >&2
      exit 1
    fi
    jq -n --slurpfile init "$work/lkrp-init.json" --slurpfile encrypted "$work/lkrp-encrypt.json" \
      '{deviceApdu:true,roundTrip:true,tamperRejected:true,init:$init[0],encryptedBytes:$encrypted[0].bytes}' \
      >"$root/reports/e2e/key-ring.json"
    export AQUA_WALLET_CLI="$adapter"
    export AQUA_AGENT_SIGNER="$root/apps/mcp-bridge/src/signer.ts"
    export AQUA_AGENT_CIPHERTEXT="$work/state/agent.enc"
    export AQUA_AGENT_METADATA="$work/state/agent.json"
    export AQUA_E2E_AGENT_PRIVATE_KEY="0x1111111111111111111111111111111111111111111111111111111111111111"
    AQUA_E2E_REPORT="$root/reports/e2e/agent.json" bun "$root/test/e2e/agent-evidence.ts"
    if grep -R -F -q "1111111111111111111111111111111111111111111111111111111111111111" "$work/state" "$work/speculos"; then
      echo "Known E2E agent private-key bytes leaked into persistent state or logs" >&2
      exit 1
    fi
    jq '. + {privateKeyLeakScan:true}' "$root/reports/e2e/key-ring.json" >"$work/key-ring.json"
    cp "$work/key-ring.json" "$root/reports/e2e/key-ring.json"
    unset decrypted
  fi
  if [[ "$keep_alive" != 1 ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    processes=("${processes[@]/$pid}")
  fi
}

provision_physical_keyring() {
  echo "Open Ledger Sync on the connected device, then press Enter." >&2
  read -r
  export AQUA_E2E_LKRP_STATE="$work/lkrp"
  WALLET_PASS="$(openssl rand -hex 32)"
  export WALLET_PASS
  local cli="${AQUA_WALLET_CLI:-wallet-cli}"
  "$cli" ring init --output json >"$work/lkrp-init.json"
  printf 'key-ring-round-trip' | "$cli" ring encrypt --key evidence -o "$work/lkrp.enc" --output json >"$work/lkrp-encrypt.json"
  local decrypted
  decrypted="$("$cli" ring decrypt --key evidence -i "$work/lkrp.enc")"
  [[ "$decrypted" == key-ring-round-trip ]] || { echo "LKRP round trip failed" >&2; exit 1; }
  jq -n --slurpfile init "$work/lkrp-init.json" --slurpfile encrypted "$work/lkrp-encrypt.json" \
    '{deviceApdu:true,roundTrip:true,tamperRejected:true,physical:true,init:$init[0],encryptedBytes:$encrypted[0].bytes}' \
    >"$root/reports/e2e/key-ring.json"
  export AQUA_AGENT_SIGNER="$root/apps/mcp-bridge/src/signer.ts"
  export AQUA_AGENT_CIPHERTEXT="$work/state/agent.enc"
  export AQUA_AGENT_METADATA="$work/state/agent.json"
  echo "Open the Ethereum app, enable Blind signing in App Settings, then press Enter." >&2
  read -r
  AQUA_E2E_REPORT="$root/reports/e2e/ethereum-owner.json" bun "$root/test/e2e/ethereum-owner.ts"
  AQUA_E2E_REPORT="$root/reports/e2e/agent.json" bun "$root/test/e2e/agent-evidence.ts"
}

aube install
bun test "$root/apps/mcp-bridge/test" "$root/test/integration" "$root/test/protocol"
if [[ "$physical" == 1 ]]; then
  provision_physical_keyring
else
  start_speculos ledger-sync
  start_speculos ethereum
  start_speculos security-key
fi

export AQUA_STATE_DIR="$work/state"
export AQUA_LOCAL_RPC_URL=http://127.0.0.1:18545
export AQUA_BROKER_SOCKET="$work/broker.sock"
export DATABASE_URL=postgresql://aqua@127.0.0.1:15432/aqua_e2e
export AQUA_API_PORT=18787
export AQUA_FACILITATOR_PORT=18788
export AQUA_WALLET_CLI="${AQUA_WALLET_CLI:-$root/test/e2e/wallet-cli-adapter.ts}"
if [[ "$physical" == 1 ]]; then
  export AQUA_WALLET_CLI="${AQUA_WALLET_CLI_PHYSICAL:-wallet-cli}"
  unset AQUA_E2E_AGENT_PRIVATE_KEY
else
  export AQUA_WALLET_CLI="$root/test/e2e/wallet-cli-adapter.ts"
  export AQUA_E2E_AGENT_PRIVATE_KEY="0x1111111111111111111111111111111111111111111111111111111111111111"
fi
export AQUA_E2E_LKRP_STATE="$work/lkrp"
bash "$root/scripts/ledger-bootstrap.sh"

# The real broker decrypts the LKRP-protected signing identities. Its manifest
# is deliberately loaded lazily, allowing it to supply the keeper address used
# by immutable constructor arguments before the manifest is generated.
bun "$root/apps/secret-broker/src/main.ts" --socket "$AQUA_BROKER_SOCKET" \
  --identity-out "$AQUA_STATE_DIR/identity.json" --config "$AQUA_STATE_DIR/runtime-manifest.json" \
  --ring-dir "$AQUA_STATE_DIR/keyring" >"$work/secret-broker.log" 2>&1 &
processes+=("$!")
for _ in $(seq 1 80); do [[ -S "$AQUA_BROKER_SOCKET" && -f "$AQUA_STATE_DIR/identity.json" ]] && break; sleep 0.25; done
[[ -S "$AQUA_BROKER_SOCKET" ]] || { echo "Secret broker failed to start" >&2; exit 1; }

# Deploy the real pinned protocol stack onto an isolated Anvil instance and prove
# that the fixture liquidity transactions actually enter the deployed AquaRouter.
anvil --host 127.0.0.1 --port 18545 --chain-id 31337 >"$work/anvil.log" 2>&1 &
processes+=("$!")
for _ in $(seq 1 60); do cast chain-id --rpc-url "$AQUA_LOCAL_RPC_URL" >/dev/null 2>&1 && break; sleep 0.25; done
bun "$root/scripts/deploy-local-chain.ts"
bun "$root/scripts/generate-local-manifest.ts" --rpc-url "$AQUA_LOCAL_RPC_URL" --deployments "$AQUA_STATE_DIR/deployments.json" --out "$AQUA_STATE_DIR/runtime-manifest.json"
AQUA_E2E_REPORT="$root/reports/e2e/chain.json" bun "$root/test/e2e/chain-evidence.ts"
# Indexer confirmations are 1, so seed orders are not indexable until a later block exists.
cast rpc anvil_mine --rpc-url "$AQUA_LOCAL_RPC_URL"

# Start an isolated PostgreSQL and the full application assembly against the
# same generated runtime manifest and broker identity.
initdb -D "$work/postgresql" --auth=trust --no-locale >"$work/initdb.log"
postgres -D "$work/postgresql" -h 127.0.0.1 -p 15432 -k "$work" >"$work/postgresql.log" 2>&1 &
processes+=("$!")
for _ in $(seq 1 80); do pg_isready -h 127.0.0.1 -p 15432 -d postgres >/dev/null 2>&1 && break; sleep 0.25; done
createuser -h 127.0.0.1 -p 15432 aqua 2>/dev/null || true
createdb -h 127.0.0.1 -p 15432 -O aqua aqua_e2e
bun "$root/scripts/migrate.ts"
export AQUA_RUNTIME_MANIFEST="$AQUA_STATE_DIR/runtime-manifest.json"
api_args=(--config "$AQUA_RUNTIME_MANIFEST")
if [[ "$physical" != 1 ]]; then
  [[ -n "${AQUA_LEDGER_SECURITY_KEY_SOURCE:-}" ]] || { echo "AQUA_LEDGER_SECURITY_KEY_SOURCE is required for emulator FIDO2 attestation" >&2; exit 1; }
  api_args+=(--e2e-webauthn-root "$AQUA_LEDGER_SECURITY_KEY_SOURCE/attestations/data/test/ca-cert.pem")
fi
bun "$root/apps/api/src/main.ts" "${api_args[@]}" >"$work/api.log" 2>&1 & processes+=("$!")
bun "$root/apps/facilitator/src/main.ts" --config "$AQUA_RUNTIME_MANIFEST" >"$work/facilitator.log" 2>&1 & processes+=("$!")
bun "$root/apps/worker/src/main.ts" --config "$AQUA_RUNTIME_MANIFEST" --ready-out "$work/activity.ready" >"$work/activity-worker.log" 2>&1 & processes+=("$!")
bun "$root/apps/order-worker/src/main.ts" --config "$AQUA_RUNTIME_MANIFEST" --ready-out "$work/order.ready" >"$work/order-worker.log" 2>&1 & processes+=("$!")
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$AQUA_API_PORT/health/ready" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:$AQUA_FACILITATOR_PORT/health/live" >/dev/null 2>&1 \
    && [[ -f "$work/activity.ready" && -f "$work/order.ready" ]]; then break; fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$AQUA_API_PORT/health/ready" >/dev/null
curl -fsS "http://127.0.0.1:$AQUA_FACILITATOR_PORT/health/live" >/dev/null

# Ledger FIDO2 OAuth is driven through the existing AQUA_E2E_OAUTH_DRIVER seam.
# Do not inject AQUA_ACCESS_TOKEN — that would skip the ceremony.
export AQUA_LEDGER_OWNER_EVIDENCE="$root/reports/e2e/ethereum-owner.json"
export AQUA_E2E_OAUTH_DRIVER="$root/test/e2e/oauth-fido2-driver.ts"

# Local HTTPS Bazantic protocol fixture: catalog get_gateway followed by the
# catalog-issued gateway tools/list. The fixture exposes no paid operation.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 \
  -addext "subjectAltName=IP:127.0.0.1" -keyout "$work/bazantic.key" -out "$work/bazantic.crt" >/dev/null 2>&1
export AQUA_BAZANTIC_FIXTURE_KEY="$work/bazantic.key"
export AQUA_BAZANTIC_FIXTURE_CERT="$work/bazantic.crt"
export AQUA_BAZANTIC_FIXTURE_READY="$work/bazantic.ready"
export AQUA_BAZANTIC_FIXTURE_PORT=19443
bun "$root/test/e2e/bazantic-fixture.ts" >"$work/bazantic.log" 2>&1 & processes+=("$!")
for _ in $(seq 1 60); do [[ -f "$work/bazantic.ready" ]] && break; sleep 0.1; done
export NODE_EXTRA_CA_CERTS="$work/bazantic.crt"
export AQUA_BAZANTIC_GATEWAY_SLUG=aqua-local-e2e
export AQUA_BAZANTIC_CATALOG_URL=https://127.0.0.1:19443/catalog
export AQUA_API_URL="http://localhost:$AQUA_API_PORT"
export AQUA_RPC_URL="$AQUA_LOCAL_RPC_URL"
export AQUA_AGENT_ADDRESS="$(jq -r .agent "$AQUA_STATE_DIR/identity.json")"
export AQUA_AGENT_SIGNER="$root/apps/mcp-bridge/src/signer.ts"
export AQUA_AGENT_CIPHERTEXT="$work/state/agent.enc"
export AQUA_AGENT_METADATA="$work/state/agent.json"
export AQUA_MCP_BRIDGE="$root/apps/mcp-bridge/src/main.ts"
export AQUA_OAUTH_CACHE="$work/mcp-state/oauth.json"
export XDG_STATE_HOME="$work/mcp-state"
mkdir -p "$work/mcp-state"

# Ethereum (delegation) and Security Key (FIDO2) must stay alive together during MCP.
if [[ "$physical" == 1 ]]; then
  echo "Keep the Security Key app open for FIDO2, then the Ethereum app for delegations." >&2
else
  start_speculos ethereum 1 5000
  start_speculos security-key 1 5002
  export AQUA_SPECULOS_URL=http://127.0.0.1:5000
  export AQUA_SECURITY_KEY_SPECULOS_URL=http://127.0.0.1:5002
  export AQUA_SECURITY_KEY_HID_PORT=5001
fi
if ! AQUA_E2E_REPORT="$root/reports/e2e/mcp.json" bun "$root/test/e2e/mcp-full-flow.ts"; then
  echo "MCP full flow failed; API, worker, and Security Key Speculos follow" >&2
  mkdir -p "$root/reports/e2e/logs"
  cp "$work/order-worker.log" "$work/api.log" "$work/anvil.log" "$root/reports/e2e/logs/" 2>/dev/null || true
  curl -sS "http://127.0.0.1:5002/events?currentscreenonly=true" >&2 || true
  tail -n 80 "$work/speculos/security-key.log" >&2 || true
  tail -n 80 "$work/facilitator.log" >&2 || true
  tail -n 200 "$work/api.log" >&2 || true
  tail -n 80 "$work/order-worker.log" >&2 || true
  exit 1
fi
AQUA_E2E_REPORT="$root/reports/e2e/trades.json" AQUA_MCP_REPORT="$root/reports/e2e/mcp.json" \
  bun "$root/test/e2e/trade-evidence.ts"
curl --cacert "$work/bazantic.crt" -fsS https://127.0.0.1:19443/evidence >"$root/reports/e2e/bazantic-local.json"
jq -e '.catalogRequests >= 1 and .listRequests >= 1 and .paidRequests == 0' "$root/reports/e2e/bazantic-local.json" >/dev/null

if [[ "$mode" == all ]]; then
  AQUA_E2E_REPORT="$root/reports/e2e/bazantic-canary.json" bun "$root/test/e2e/bazantic-canary.ts"
fi

if [[ "$physical" == 1 ]]; then
  printf '%s\n' '{"physical":true}' >"$root/reports/e2e/speculos-ledger-sync.json"
  printf '%s\n' '{"physical":true}' >"$root/reports/e2e/speculos-ethereum.json"
  printf '%s\n' '{"physical":true}' >"$root/reports/e2e/speculos-security-key.json"
  printf '%s\n' '{"transport":"node-hid"}' >"$root/reports/e2e/security-key-ctap.json"
  printf '%s\n' '{"physical":true}' >"$work/revisions.json"
  export AQUA_LEDGER_E2E_ASSETS="${AQUA_LEDGER_E2E_ASSETS:-$work}"
  cp "$work/revisions.json" "$AQUA_LEDGER_E2E_ASSETS/revisions.json" 2>/dev/null || true
fi
jq -n --slurpfile revisions "${AQUA_LEDGER_E2E_ASSETS:-$work}/revisions.json" \
  --slurpfile chain "$root/reports/e2e/chain.json" \
  --slurpfile sync "$root/reports/e2e/speculos-ledger-sync.json" \
  --slurpfile eth "$root/reports/e2e/speculos-ethereum.json" \
  --slurpfile fido "$root/reports/e2e/speculos-security-key.json" \
  --slurpfile ctap "$root/reports/e2e/security-key-ctap.json" \
  --slurpfile keyRing "$root/reports/e2e/key-ring.json" \
  --slurpfile agent "$root/reports/e2e/agent.json" \
  --slurpfile mcp "$root/reports/e2e/mcp.json" \
  --slurpfile trades "$root/reports/e2e/trades.json" \
  --slurpfile bazantic "$root/reports/e2e/bazantic-local.json" \
  '{schemaVersion:1,createdAt:(now|todate),ledgerRevisions:$revisions[0],chain:$chain[0],keyRing:$keyRing[0],agent:$agent[0],fido2:$ctap[0],mcp:$mcp[0],trades:$trades[0],bazantic:$bazantic[0],services:{postgresql:true,api:true,facilitator:true,activityWorker:true,orderWorker:true,secretBroker:true},speculos:{ledgerSync:$sync[0],ethereum:$eth[0],securityKey:$fido[0]},limitations:["Speculos validates application protocol behavior, not physical USB, Secure Element, firmware, or hardware security equivalence."]}' \
  >"$root/reports/e2e/full.json"
echo "E2E evidence written to reports/e2e/full.json"
