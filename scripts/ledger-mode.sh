# Shared --dev / --prod / --ledger parsing for Aqua shell commands.
# Sets AQUA_LEDGER to emulator|physical and AQUA_LEDGER_REST to remaining args.

aqua_parse_ledger_value() {
  case "$1" in
    emulator|emulated|dev) printf '%s' emulator ;;
    physical|prod) printf '%s' physical ;;
    *)
      echo "Ledger mode must be emulator or physical (--ledger emulator|physical, aliases: --dev, --prod), not $1" >&2
      return 2
      ;;
  esac
}

aqua_consume_ledger_args() {
  local default_mode=physical
  if [[ "${1:-}" == --default ]]; then
    default_mode="$(aqua_parse_ledger_value "$2")" || return
    shift 2
  fi
  AQUA_LEDGER_REST=()
  local flagged=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dev)
        if [[ "$flagged" == physical ]]; then
          echo "--dev and --prod cannot be combined" >&2
          return 2
        fi
        flagged=emulator
        shift
        ;;
      --prod)
        if [[ "$flagged" == emulator ]]; then
          echo "--dev and --prod cannot be combined" >&2
          return 2
        fi
        flagged=physical
        shift
        ;;
      --ledger)
        local parsed
        parsed="$(aqua_parse_ledger_value "${2:-}")" || return
        if [[ -n "$flagged" && "$flagged" != "$parsed" ]]; then
          echo "--dev and --prod cannot be combined" >&2
          return 2
        fi
        flagged="$parsed"
        shift 2
        ;;
      --ledger=*)
        local parsed
        parsed="$(aqua_parse_ledger_value "${1#--ledger=}")" || return
        if [[ -n "$flagged" && "$flagged" != "$parsed" ]]; then
          echo "--dev and --prod cannot be combined" >&2
          return 2
        fi
        flagged="$parsed"
        shift
        ;;
      *)
        AQUA_LEDGER_REST+=("$1")
        shift
        ;;
    esac
  done
  if [[ -n "$flagged" ]]; then
    AQUA_LEDGER="$flagged"
  elif [[ -n "${AQUA_LEDGER:-}" ]]; then
    AQUA_LEDGER="$(aqua_parse_ledger_value "$AQUA_LEDGER")" || return
  elif [[ "${AQUA_LEDGER_TRANSPORT:-}" == speculos ]]; then
    AQUA_LEDGER=emulator
  else
    AQUA_LEDGER="$default_mode"
  fi
}

aqua_apply_ledger_env() {
  export AQUA_LEDGER
  local root="${AQUA_ROOT:-$PWD}"
  local state_dir="${AQUA_STATE_DIR:-$root/.data}"
  if [[ "$AQUA_LEDGER" == emulator ]]; then
    export AQUA_E2E=1
    export AQUA_LEDGER_TRANSPORT=speculos
    export AQUA_SPECULOS_URL="${AQUA_SPECULOS_URL:-http://127.0.0.1:5000}"
    export AQUA_WALLET_CLI="${AQUA_WALLET_CLI:-$root/test/e2e/wallet-cli-adapter.ts}"
    export AQUA_E2E_LKRP_STATE="${AQUA_E2E_LKRP_STATE:-$state_dir/lkrp}"
  else
    export AQUA_LEDGER_TRANSPORT=node-hid
  fi
}
