# Dockerfile
FROM nixos/nix:2.28.3

RUN printf '%s\n' \
    'experimental-features = nix-command flakes' \
    'filter-syscalls = false' \
    'accept-flake-config = true' \
    >> /etc/nix/nix.conf

WORKDIR /workspace
