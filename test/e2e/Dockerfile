FROM nixos/nix:2.31.2
RUN echo 'experimental-features = nix-command flakes' >> /etc/nix/nix.conf
WORKDIR /workspace
ENTRYPOINT ["nix", "develop", "--accept-flake-config", "-c"]
