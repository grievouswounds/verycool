#!/bin/sh
set -eu

mkdir -p /workspace/node_modules /workspace/.data /home/aqua/.cache/aube /home/aqua/.local/share/aube
chown -R aqua:aqua /workspace/node_modules /workspace/.data /home/aqua/.cache /home/aqua/.local

exec su-exec aqua nix develop --impure --accept-flake-config -c "$@"
