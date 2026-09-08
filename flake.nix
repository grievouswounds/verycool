{
  description = "Native Bun Aqua transaction-preparation backend";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.aqua = {
    url = "github:1inch/aqua/9c5c42e5840e8741fba3597c48456c9510212b66";
    flake = false;
  };
  inputs.swapvm = {
    url = "github:1inch/swap-vm/f09a41e689240adc645934f965c8061749397cd2";
    flake = false;
  };
  inputs.x402 = {
    # x402's own contracts/evm depends on forge-std/openzeppelin-contracts/permit2 as git
    # submodules rather than npm packages. The "github:" shorthand fetches a plain source
    # archive (GitHub's tarball API), which never contains submodule content no matter what
    # query parameters are added; only the real git fetcher ("git+https://...") can check
    # submodules out, via "submodules=1".
    url = "git+https://github.com/x402-foundation/x402?rev=241df66079aa22d5572e940b2b5340b7a577963a&submodules=1";
    flake = false;
  };
  inputs.permit2 = {
    # Likewise, permit2 depends on forge-std/solmate/openzeppelin-contracts/forge-gas-snapshot
    # as git submodules, which needs the same "git+https://...submodules=1" fetcher.
    url = "git+https://github.com/Uniswap/permit2?rev=cc56ad0f3439c502c246fc5cfcc3db92bb8b7219&submodules=1";
    flake = false;
  };

  outputs =
    {
      self,
      nixpkgs,
      aqua,
      swapvm,
      x402,
      permit2,
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
        };
      aube171 =
        pkgs:
        pkgs.rustPlatform.buildRustPackage {
          pname = "aube";
          version = "1.17.0";
          src = pkgs.fetchFromGitHub {
            owner = "aubepkg";
            repo = "aube";
            rev = "v1.17.0";
            hash = "sha256-zS9x4Dg1JnAC2nkzJ8Z4g+vOe4IfJKla2d+R+4QZRxo=";
          };
          cargoHash = "sha256-m8ZmU1PVx1PN2IeiKAh4T625PFBed2sdnLZS7751b4I=";
          doCheck = false;
          nativeBuildInputs = [
            pkgs.cmake
            pkgs.pkg-config
          ];
          meta = {
            description = "A fast Node.js package manager";
            homepage = "https://github.com/aubepkg/aube";
            license = pkgs.lib.licenses.mit;
            mainProgram = "aube";
          };
        };
      appProgram =
        pkgs: name: source:
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [ pkgs.bun ];
          text = ''
            export LANG=C.UTF-8
            export LC_ALL=C.UTF-8
            exec bun "$PWD/${source}" "$@"
          '';
        };
      devStack =
        pkgs: aube: aqua: swapvm: x402: permit2: commandName: hotReload:
        let
          processComposeConfig = pkgs.writeText "aqua-process-compose.yaml" ''
            version: "0.5"
            ordered_shutdown: true

            processes:
              postgresql:
                # Reuse an explicitly user-managed server already listening on the configured
                # local port; otherwise Process Compose owns PostgreSQL and shuts it down with
                # the rest of the stack. The devShell itself never starts background services.
                command: >-
                  pg_isready -h 127.0.0.1 -p 5432 -d postgres >/dev/null 2>&1 &&
                  exec tail -f /dev/null ||
                  exec postgres -D "$${AQUA_STATE_DIR}/postgresql"
                readiness_probe:
                  exec:
                    command: pg_isready -h 127.0.0.1 -p 5432 -d postgres
                  initial_delay_seconds: 1
                  period_seconds: 1
                  timeout_seconds: 2
                  success_threshold: 1
                  failure_threshold: 30

              postgres-init:
                command: >-
                  ${pkgs.postgresql_18}/bin/createuser -h 127.0.0.1 aqua 2>/dev/null || true;
                  ${pkgs.postgresql_18}/bin/createdb -h 127.0.0.1 -O aqua aqua_backend 2>/dev/null || true;
                  bun "$${AQUA_ROOT}/scripts/migrate.ts"
                depends_on:
                  postgresql:
                    condition: process_healthy

              anvil:
                # A local chain for the protocol contracts api/activity-worker/order-worker all
                # need a runtime manifest for. "--state" both loads and periodically dumps chain
                # state, so a restarted "dev" reuses the same deployed contract addresses instead
                # of orphaning the manifest generated on a previous run.
                command: >-
                  anvil --host 127.0.0.1 --port 8545 --chain-id 31337
                  --state "$${AQUA_STATE_DIR}/anvil-state.json" --state-interval 5
                readiness_probe:
                  exec:
                    command: cast chain-id --rpc-url "$${AQUA_LOCAL_RPC_URL}"
                  initial_delay_seconds: 1
                  period_seconds: 1
                  timeout_seconds: 2
                  success_threshold: 1
                  failure_threshold: 30

              secret-broker:
                # Real, Ledger-backed mode only: the launcher runs ledger-bootstrap before the
                # supervisor, producing or validating the encrypted keyring. "--config" is read lazily
                # on the broker's first real signing request, so it is safe to point at a
                # manifest that "manifest-generate" below has not written yet.
                command: >-
                  bun "$${AQUA_ROOT}/apps/secret-broker/src/main.ts"
                  --socket "$${AQUA_STATE_DIR}/secret-broker.sock"
                  --identity-out "$${AQUA_STATE_DIR}/identity.json"
                  --config "$${AQUA_STATE_DIR}/runtime-manifest.json"
                  --ring-dir "$${AQUA_STATE_DIR}/keyring"
                readiness_probe:
                  exec:
                    command: >-
                      test -S "$${AQUA_STATE_DIR}/secret-broker.sock" &&
                      test -f "$${AQUA_STATE_DIR}/identity.json"
                  initial_delay_seconds: 1
                  period_seconds: 1
                  timeout_seconds: 2
                  success_threshold: 1
                  failure_threshold: 30

              contracts-deploy:
                # Deploys the Aqua/SwapVM/x402/Permit2 protocol stack plus fixture tokens to the
                # local Anvil chain and writes deployments.json. Needs the broker's real keeper
                # address (from identity.json) first, since AquaIntentController's immutable
                # "operator" must be that address. Idempotent: reuses a prior deployment when
                # Anvil's persisted state still has code at the recorded addresses.
                command: bun "$${AQUA_ROOT}/scripts/deploy-local-chain.ts"
                depends_on:
                  anvil:
                    condition: process_healthy
                  secret-broker:
                    condition: process_healthy

              manifest-generate:
                command: >-
                  bun "$${AQUA_ROOT}/scripts/generate-local-manifest.ts"
                  --rpc-url "$${AQUA_LOCAL_RPC_URL}"
                  --deployments "$${AQUA_STATE_DIR}/deployments.json"
                  --out "$${AQUA_STATE_DIR}/runtime-manifest.json"
                depends_on:
                  contracts-deploy:
                    condition: process_completed_successfully

              api:
                command: >-
                  ${if hotReload then "bun --hot" else "bun"} "$${AQUA_ROOT}/apps/api/src/main.ts"
                  --config "$${AQUA_STATE_DIR}/runtime-manifest.json"
                depends_on:
                  postgres-init:
                    condition: process_completed_successfully
                  manifest-generate:
                    condition: process_completed_successfully
                availability:
                  restart: on_failure
                  backoff_seconds: 2
                readiness_probe:
                  exec:
                    command: curl --fail --silent "http://127.0.0.1:$${AQUA_API_PORT}/health/ready" >/dev/null
                  initial_delay_seconds: 1
                  period_seconds: 2
                  timeout_seconds: 2
                  success_threshold: 1
                  failure_threshold: 30

              activity-worker:
                command: >-
                  bun "$${AQUA_ROOT}/apps/worker/src/main.ts"
                  --config "$${AQUA_STATE_DIR}/runtime-manifest.json"
                  --ready-out "$${AQUA_STATE_DIR}/activity-worker.ready"
                depends_on:
                  postgres-init:
                    condition: process_completed_successfully
                  manifest-generate:
                    condition: process_completed_successfully
                availability:
                  restart: on_failure
                  backoff_seconds: 2
                readiness_probe:
                  exec:
                    command: test -f "$${AQUA_STATE_DIR}/activity-worker.ready"
                  initial_delay_seconds: 1
                  period_seconds: 1
                  timeout_seconds: 2
                  success_threshold: 1
                  failure_threshold: 30

              order-worker:
                command: >-
                  bun "$${AQUA_ROOT}/apps/order-worker/src/main.ts"
                  --config "$${AQUA_STATE_DIR}/runtime-manifest.json"
                  --ready-out "$${AQUA_STATE_DIR}/order-worker.ready"
                depends_on:
                  postgres-init:
                    condition: process_completed_successfully
                  manifest-generate:
                    condition: process_completed_successfully
                availability:
                  restart: on_failure
                  backoff_seconds: 2
                readiness_probe:
                  exec:
                    command: test -f "$${AQUA_STATE_DIR}/order-worker.ready"
                  initial_delay_seconds: 1
                  period_seconds: 1
                  timeout_seconds: 2
                  success_threshold: 1
                  failure_threshold: 30
          '';
        in
        pkgs.writeShellApplication {
          name = commandName;
          runtimeInputs = [
            aube
            pkgs.bun
            pkgs.curl
            pkgs.postgresql_18
            pkgs.process-compose
            pkgs.foundry
            pkgs.openssl
          ];
          text = ''
            export LANG=C.UTF-8
            export LC_ALL=C.UTF-8
            export AQUA_ROOT="$PWD"
            # node_modules/.bin holds wallet-cli ("@ledgerhq/wallet-cli"), which secret-broker
            # (real, non-fixture mode) shells out to. The devShell shellHook already prepends
            # this for "nix develop -c dev"; setting it here too keeps "nix run .#dev" working
            # the same way, matching how ledger-bootstrap already does this for itself.
            export PATH="$PWD/node_modules/.bin:$PATH"
            export AQUA_STATE_DIR="''${AQUA_STATE_DIR:-$PWD/.data}"
            export DATABASE_URL="''${DATABASE_URL:-postgresql://aqua:aqua@127.0.0.1:5432/aqua_backend}"
            export AQUA_UPSTREAM=${aqua}
            export SWAPVM_UPSTREAM=${swapvm}
            export X402_UPSTREAM=${x402}
            export PERMIT2_UPSTREAM=${permit2}
            export AQUA_LOCAL_RPC_URL="''${AQUA_LOCAL_RPC_URL:-http://127.0.0.1:8545}"
            export AQUA_BROKER_SOCKET="''${AQUA_BROKER_SOCKET:-$AQUA_STATE_DIR/secret-broker.sock}"
            export AQUA_API_PORT="''${AQUA_API_PORT:-8787}"
            export AQUA_FACILITATOR_PORT="''${AQUA_FACILITATOR_PORT:-8788}"
            aube install
            bash "$AQUA_ROOT/scripts/ledger-bootstrap.sh"
            rm -f "$AQUA_STATE_DIR/activity-worker.ready" "$AQUA_STATE_DIR/order-worker.ready"
            if [ ! -d "$AQUA_STATE_DIR/postgresql" ]; then
              initdb -D "$AQUA_STATE_DIR/postgresql" --auth=trust
            fi
            exec process-compose --ordered-shutdown -f ${processComposeConfig}
          '';
        };
    in
    {
      packages = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
          aube = aube171 pkgs;
          api = appProgram pkgs "aqua-api" "apps/api/src/main.ts";
          worker = appProgram pkgs "aqua-activity-worker" "apps/worker/src/main.ts";
          orderWorker = appProgram pkgs "aqua-order-worker" "apps/order-worker/src/main.ts";
          dev = devStack pkgs aube aqua swapvm x402 permit2 "dev" true;
          start = devStack pkgs aube aqua swapvm x402 permit2 "aqua-start" false;
          checkLocal = pkgs.writeShellApplication {
            name = "check-local";
            runtimeInputs = [
              aube
              pkgs.bun
              pkgs.foundry
              pkgs.git
              pkgs.jq
              pkgs.nix
              pkgs.postgresql_18
            ];
            text = ''exec bash "$PWD/scripts/check-local.sh" "$@"'';
          };
          ledgerBootstrap = pkgs.writeShellApplication {
            name = "ledger-bootstrap";
            runtimeInputs = [
              aube
              pkgs.bun
              pkgs.openssl
            ];
            text = ''
              export LANG=C.UTF-8
              export LC_ALL=C.UTF-8
              aube install
              export PATH="$PWD/node_modules/.bin:$PATH"
              exec bash "$PWD/scripts/ledger-bootstrap.sh" "$@"
            '';
          };
        in
        {
          default = api;
          inherit
            aube
            api
            worker
            dev
            start
            checkLocal
            ledgerBootstrap
            ;
          order-worker = orderWorker;
        }
      );

      apps = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
          packages = self.packages.${system};
        in
        {
          default = {
            type = "app";
            program = "${packages.api}/bin/aqua-api";
          };
          dev = {
            type = "app";
            program = "${packages.dev}/bin/dev";
          };
          start = {
            type = "app";
            program = "${packages.start}/bin/aqua-start";
          };
          worker = {
            type = "app";
            program = "${packages.worker}/bin/aqua-activity-worker";
          };
          order-worker = {
            type = "app";
            program = "${packages.order-worker}/bin/aqua-order-worker";
          };
          check-local = {
            type = "app";
            program = "${packages.checkLocal}/bin/check-local";
          };
          ledger-bootstrap = {
            type = "app";
            program = "${packages.ledgerBootstrap}/bin/ledger-bootstrap";
          };
        }
      );

      checks = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          formatting = pkgs.runCommand "nix-format-check" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
            nixfmt --check ${./flake.nix}
            touch $out
          '';
          dependency-policy = pkgs.runCommand "dependency-policy" { } ''
            ! grep -E '(^|[/@])(ethers|web3)(@|:)' ${./aube-lock.yaml}
            ! grep -E '"(viem|ethers|web3)"[[:space:]]*:' ${./package.json}
            touch $out
          '';
        }
      );

      devShells = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
          aube = aube171 pkgs;
          dev = devStack pkgs aube aqua swapvm x402 permit2 "dev" true;
          start = devStack pkgs aube aqua swapvm x402 permit2 "aqua-start" false;
          ledgerBootstrap = self.packages.${system}.ledgerBootstrap;
        in
        {
          default = pkgs.mkShell {
            LANG = "C.UTF-8";
            LC_ALL = "C.UTF-8";
            packages = [
              aube
              dev
              start
              ledgerBootstrap
              pkgs.bun
              pkgs.nodejs
              pkgs.yarn
              pkgs.gnumake
              pkgs.jq
              pkgs.git
              pkgs.openssl
              pkgs.postgresql_18
              pkgs.foundry
              pkgs.process-compose
              pkgs.turbo
              pkgs.nixfmt
            ];
            shellHook = ''
              aube install
              export AQUA_ROOT="$PWD"
              export PATH="$PWD/node_modules/.bin:$PATH"
              export AQUA_UPSTREAM=${aqua}
              export SWAPVM_UPSTREAM=${swapvm}
              export X402_UPSTREAM=${x402}
              export PERMIT2_UPSTREAM=${permit2}
              export AQUA_STATE_DIR="''${AQUA_STATE_DIR:-$PWD/.data}"
              export DATABASE_URL="''${DATABASE_URL:-postgresql://aqua:aqua@127.0.0.1:5432/aqua_backend}"
              mkdir -p "$AQUA_STATE_DIR"
            '';
          };
        }
      );
    };
}
