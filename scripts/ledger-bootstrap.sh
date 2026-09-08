#!/usr/bin/env bash
set -euo pipefail

state_dir="${AQUA_STATE_DIR:-$PWD/.data}"
ring_dir="$state_dir/keyring"
mkdir -p "$ring_dir"
chmod 700 "$ring_dir"

wallet_pass="$(security find-generic-password -w -s aqua-ledger-wallet-pass)"
export WALLET_PASS="$wallet_pass"
trap 'unset WALLET_PASS wallet_pass' EXIT

wallet-cli genuine-check --output json
wallet-cli account discover --currency ethereum --output json
wallet-cli ring init
for key_name in agent facilitator keeper paseto; do
  umask 077
  openssl rand -hex 32 | wallet-cli ring encrypt --key "$key_name" -o "$ring_dir/$key_name.enc"
done
echo "Encrypted broker keys created in $ring_dir"
