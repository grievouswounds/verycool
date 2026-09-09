set -eu

uid="${AQUA_UID:-501}"
gid="${AQUA_GID:-20}"
chmod 644 /etc/passwd /etc/group 2>/dev/null || true

mkdir -p /workspace/node_modules /workspace/.data /home/aqua/.cache/aube /home/aqua/.local/share/aube /run/postgresql
chown -R "${uid}:${gid}" /nix /workspace/node_modules /workspace/.data /home/aqua/.cache /home/aqua/.local /run/postgresql

exec /usr/local/bin/su-exec "${uid}:${gid}" nix develop --impure --accept-flake-config -c "$@"
