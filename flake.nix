{
  description = "Native Bun Aqua transaction-preparation backend";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.aqua = {
    url = "github:1inch/aqua/9c5c42e5840e8741fba3597c48456c9510212b66";
    flake = false;
  };
  inputs.swapvm = {
    url = "github:1inch/swap-vm/32c687c2b73101fc26549e48fa1ff8a4d73afbac";
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
  inputs.speculos-src = {
    url = "github:LedgerHQ/speculos/b8223017fd831663fd3e3fcf83f85ba234970615";
    flake = false;
  };
  inputs.ledger-secure-sdk = {
    url = "github:LedgerHQ/ledger-secure-sdk/7f80658e0e937952ca805849e4e561539db33385";
    flake = false;
  };
  inputs.ledger-security-key = {
    url = "github:LedgerHQ/app-security-key/a4d0dd24bdeee8de4a62ae146ad735b5c41a50e8";
    flake = false;
  };
  inputs.ledger-sync = {
    url = "github:LedgerHQ/app-ledger-sync/0838f1c1a1c591be7fe9f977c265cd3f45d58a9c";
    flake = false;
  };
  inputs.ledger-ethereum = {
    url = "git+https://github.com/LedgerHQ/app-ethereum?rev=e5b6dbff3aca3e3c97a1079c8dccbd1dafdb32c7&submodules=1";
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
      speculos-src,
      ledger-secure-sdk,
      ledger-security-key,
      ledger-sync,
      ledger-ethereum,
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
          cargoBuildFlags = [
            "--bin"
            "aube"
          ];
          CARGO_PROFILE_RELEASE_LTO = "false";
          CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "16";
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
      ledgerRevision = {
        speculos = "b8223017fd831663fd3e3fcf83f85ba234970615";
        securityKey = "a4d0dd24bdeee8de4a62ae146ad735b5c41a50e8";
        ledgerSync = "0838f1c1a1c591be7fe9f977c265cd3f45d58a9c";
        ethereum = "e5b6dbff3aca3e3c97a1079c8dccbd1dafdb32c7";
        secureSdk = "7f80658e0e937952ca805849e4e561539db33385";
      };
      ledgeredPackage =
        pkgs:
        pkgs.python3.pkgs.buildPythonPackage {
          pname = "ledgered";
          version = "0.14.0";
          format = "wheel";
          src = pkgs.fetchurl {
            url = "https://files.pythonhosted.org/packages/3f/a8/4f896aa525133c69bc3f2399eb190002e10bbe3528c76b3165fd31d728b8/ledgered-0.14.0-py3-none-any.whl";
            hash = "sha256-qPMi2SBJWVnvCfkgUR856j/DG6hx6+TMlrswP/RboZU=";
          };
          dependencies = with pkgs.python3.pkgs; [
            pydantic
            pyelftools
            pygithub
            tomli
          ];
          doCheck = false;
        };
      ledgerApp =
        pkgs: name: source: extraMakeFlags:
        pkgs.stdenv.mkDerivation {
          pname = "ledger-${name}-nanos-plus";
          version = "git";
          src = source;
          nativeBuildInputs = [
            pkgs.gcc-arm-embedded
            pkgs.llvmPackages.clang-unwrapped
            pkgs.llvmPackages.lld
            pkgs.llvmPackages.llvm
            pkgs.gnumake
            pkgs.git
            (pkgs.python3.withPackages (python: [ python.pillow ]))
            (ledgeredPackage pkgs)
            pkgs.jq
            pkgs.which
          ];
          BOLOS_SDK = ledger-secure-sdk;
          TARGET = "nanos2";
          API_LEVEL = "26";
          enableParallelBuilding = true;
          postPatch = pkgs.lib.optionalString (name == "security-key") ''
            sed -i '/^DEFINES += ENABLE_RK_CONFIG$/d' Makefile
          '';
          buildPhase = ''
            runHook preBuild
            if [ ! -d .git ]; then
              git init --quiet
              git config user.name "Aqua reproducible Ledger build"
              git config user.email "e2e@aqua.invalid"
              git add --all
              GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" \
                git commit --quiet --message source
            fi
            make SHELL=${pkgs.bash}/bin/bash CLANGPATH=${pkgs.llvmPackages.clang-unwrapped}/bin/ API_LEVEL=$API_LEVEL DEBUG=1 ${extraMakeFlags} build/nanos2/bin/app.elf
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p "$out/share/ledger-apps"
            app_elf="$(find build -type f -name app.elf -print -quit)"
            test -n "$app_elf"
            cp "$app_elf" "$out/share/ledger-apps/${name}.elf"
            runHook postInstall
          '';
        };
      speculosPackage =
        pkgs:
        let
          python = pkgs.python3;
          ledgered = ledgeredPackage pkgs;
          qemuStaticCompat = pkgs.runCommand "qemu-arm-static-compat" { } ''
            mkdir -p "$out/bin"
            ln -s ${pkgs.qemu-user}/bin/qemu-arm "$out/bin/qemu-arm-static"
          '';
        in
        python.pkgs.buildPythonApplication {
          pname = "speculos";
          version = "0.27.0";
          format = "wheel";
          src = pkgs.fetchurl {
            url = "https://files.pythonhosted.org/packages/b9/b5/adf12e3040a5671fe1c93d00f3a5f8822b95bdb172d3d4951c30e110393a/speculos-0.27.0-py3-none-any.whl";
            hash = "sha256-dIv0CuC72INM3IqxcX1r493M6lObc6YLvHzLySePyYI=";
          };
          nativeBuildInputs = [
            pkgs.autoPatchelfHook
            pkgs.makeWrapper
          ];
          buildInputs = [ pkgs.libvncserver ];
          dependencies = with python.pkgs; [
            construct
            flask
            flask-restful
            flask-cors
            jsonschema
            mnemonic
            pillow
            pyelftools
            pyqt6
            requests
            pygame
            ledgered
          ];
          makeWrapperArgs = [
            "--prefix"
            "PATH"
            ":"
            (pkgs.lib.makeBinPath [ qemuStaticCompat ])
          ];
          # The upstream universal wheel pins Flask 2 and names the pygame
          # distribution even though pygame-ce supplies the compatible module
          # in nixpkgs. Relax/remove only that stale wheel metadata; import
          # checks below still verify the assembled closure.
          pythonRelaxDeps = [ "flask" ];
          pythonRemoveDeps = [ "pygame" ];
          pythonImportsCheck = [ "speculos" ];
          doCheck = false;
        };
      indentLines =
        n: text:
        let
          pad = nixpkgs.lib.concatStrings (nixpkgs.lib.genList (_: " ") n);
        in
        nixpkgs.lib.concatMapStringsSep "\n" (line: if line == "" then "" else pad + line) (
          nixpkgs.lib.splitString "\n" text
        );
      ledgerDispatch =
        pkgs: name: defaultMode: physicalBin: physicalName: emulatedBin: emulatedName:
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [
            pkgs.bash
            pkgs.coreutils
            physicalBin
            emulatedBin
          ];
          text = ''
            # shellcheck disable=SC1091
            source "$PWD/scripts/ledger-mode.sh"
            aqua_consume_ledger_args --default ${defaultMode} "$@" || exit
            set -- "''${AQUA_LEDGER_REST[@]}"
            aqua_apply_ledger_env
            if [[ "$AQUA_LEDGER" == emulator ]]; then
              exec ${emulatedBin}/bin/${emulatedName} "$@"
            fi
            exec ${physicalBin}/bin/${physicalName} "$@"
          '';
        };
      devStack =
        pkgs: aube: aqua: swapvm: x402: permit2: commandName: hotReload: ledgerMode:
        let
          emulated = ledgerMode == "emulated";
          emulatedProcesses = ''
            speculos:
              command: >-
                if [ -z "''${AQUA_SPECULOS_BIN:-}" ] || [ -z "''${AQUA_LEDGER_E2E_ASSETS:-}" ]; then
                  echo "Run through nix develop so the pinned Ledger ELFs and Speculos executable are available" >&2;
                  exit 1;
                fi;
                exec "''${AQUA_SPECULOS_BIN}" --model nanosp --display headless --api-port 5000 --apdu-port 9999
                --seed "glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin"
                "''${AQUA_LEDGER_E2E_ASSETS}/apps/ledger-sync.elf"
              readiness_probe:
                exec:
                  command: curl -fsS http://127.0.0.1:5000/events >/dev/null
                initial_delay_seconds: 1
                period_seconds: 1
                timeout_seconds: 2
                success_threshold: 1
                failure_threshold: 60

            ledger-bootstrap:
              command: bash "''${AQUA_ROOT}/scripts/ledger-bootstrap.sh"
              depends_on:
                speculos:
                  condition: process_healthy
          '';
          emulatedBrokerDepends = ''
            depends_on:
              ledger-bootstrap:
                condition: process_completed_successfully
          '';
          processComposeConfig = pkgs.writeText "aqua-process-compose.yaml" ''
            version: "0.5"
            ordered_shutdown: true

            processes:
            ${if emulated then indentLines 2 emulatedProcesses else ""}
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
                # Physical mode: the launcher runs ledger-bootstrap before the supervisor.
                # Emulated mode: ledger-bootstrap is a process that waits for Speculos.
                # "--config" is read lazily on the broker's first real signing request, so it is
                # safe to point at a manifest that "manifest-generate" below has not written yet.
                command: >-
                  bun "$${AQUA_ROOT}/apps/secret-broker/src/main.ts"
                  --socket "$${AQUA_STATE_DIR}/secret-broker.sock"
                  --identity-out "$${AQUA_STATE_DIR}/identity.json"
                  --config "$${AQUA_STATE_DIR}/runtime-manifest.json"
                  --ring-dir "$${AQUA_STATE_DIR}/keyring"
            ${if emulated then indentLines 4 emulatedBrokerDepends else ""}
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

              facilitator:
                command: >-
                  bun "$${AQUA_ROOT}/apps/facilitator/src/main.ts"
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
                    command: curl --fail --silent "http://127.0.0.1:$${AQUA_FACILITATOR_PORT}/health/live" >/dev/null
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
            ${
              if emulated then
                ''
                  if [ "$(uname -s)" = Darwin ] && [ "''${AQUA_EMULATED_INNER:-0}" != 1 ]; then
                    command -v docker >/dev/null || { echo "Docker is required for the Linux Speculos development environment" >&2; exit 1; }
                    export UID
                    GID="$(id -g)"
                    export GID
                    exec docker compose up --build
                  fi
                  if [ "$(uname -s)" != Linux ]; then
                    echo "emulated Ledger inner runner requires Linux" >&2
                    exit 1
                  fi
                  if [ -z "''${AQUA_SPECULOS_BIN:-}" ] || [ -z "''${AQUA_LEDGER_E2E_ASSETS:-}" ]; then
                    echo "Run through nix develop so the pinned Ledger ELFs and Speculos executable are available" >&2
                    exit 1
                  fi
                  export AQUA_E2E=1
                  export AQUA_LEDGER_TRANSPORT=speculos
                  export AQUA_WALLET_CLI="''${AQUA_WALLET_CLI:-$AQUA_ROOT/test/e2e/wallet-cli-adapter.ts}"
                  export AQUA_E2E_LKRP_STATE="''${AQUA_E2E_LKRP_STATE:-$AQUA_STATE_DIR/lkrp}"
                  export AQUA_SPECULOS_URL="''${AQUA_SPECULOS_URL:-http://127.0.0.1:5000}"
                  export AQUA_BIND_HOST="''${AQUA_BIND_HOST:-0.0.0.0}"
                  mkdir -p "$AQUA_STATE_DIR"
                  if [ ! -f "$AQUA_STATE_DIR/wallet-pass" ]; then
                    umask 077
                    openssl rand -hex 32 > "$AQUA_STATE_DIR/wallet-pass"
                    chmod 600 "$AQUA_STATE_DIR/wallet-pass"
                  fi
                  WALLET_PASS="$(cat "$AQUA_STATE_DIR/wallet-pass")"
                  export WALLET_PASS
                ''
              else
                ""
            }
            aube install
            ${
              if emulated then
                ""
              else
                ''
                  bash "$AQUA_ROOT/scripts/ledger-bootstrap.sh"
                ''
            }
            rm -f "$AQUA_STATE_DIR/activity-worker.ready" "$AQUA_STATE_DIR/order-worker.ready"
            if [ ! -d "$AQUA_STATE_DIR/postgresql" ]; then
              initdb -D "$AQUA_STATE_DIR/postgresql" --auth=trust
            fi
            tui_args=()
            if [ ! -t 1 ]; then
              tui_args+=(-t=false)
            fi
            exec process-compose --ordered-shutdown "''${tui_args[@]}" -f ${processComposeConfig}
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
          devPhysical = devStack pkgs aube aqua swapvm x402 permit2 "dev-physical" true "physical";
          startPhysical = devStack pkgs aube aqua swapvm x402 permit2 "aqua-start-physical" false "physical";
          devEmulated = devStack pkgs aube aqua swapvm x402 permit2 "dev-emulated" true "emulated";
          startEmulated = devStack pkgs aube aqua swapvm x402 permit2 "start-emulated" false "emulated";
          dev = ledgerDispatch pkgs "dev" "physical" devPhysical "dev-physical" devEmulated "dev-emulated";
          start =
            ledgerDispatch pkgs "aqua-start" "physical" startPhysical "aqua-start-physical" startEmulated
              "start-emulated";
          checkLocal = pkgs.writeShellApplication {
            name = "check-local";
            runtimeInputs = [
              aube
              pkgs.bun
              pkgs.foundry
              pkgs.curl
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
          e2e = pkgs.writeShellApplication {
            name = "e2e";
            runtimeInputs = [
              pkgs.bash
              pkgs.coreutils
              pkgs.curl
              pkgs.git
              pkgs.nix
            ];
            text = ''exec bash "$PWD/scripts/e2e.sh" deterministic "$@"'';
          };
          e2eBazanticCanary = pkgs.writeShellApplication {
            name = "e2e-bazantic-canary";
            runtimeInputs = [
              pkgs.bash
              pkgs.bun
              pkgs.coreutils
            ];
            text = ''exec bash "$PWD/scripts/e2e.sh" bazantic-canary "$@"'';
          };
          e2eAll = pkgs.writeShellApplication {
            name = "e2e-all";
            runtimeInputs = [
              pkgs.bash
              pkgs.bun
              pkgs.coreutils
              pkgs.git
              pkgs.nix
            ];
            text = ''exec bash "$PWD/scripts/e2e.sh" all "$@"'';
          };
          e2ePhysical = pkgs.writeShellApplication {
            name = "e2e-physical";
            runtimeInputs = [
              pkgs.bash
              pkgs.coreutils
              pkgs.git
              pkgs.nix
            ];
            text = ''exec bash "$PWD/scripts/e2e.sh" physical "$@"'';
          };
          deploy = pkgs.writeShellApplication {
            name = "deploy";
            runtimeInputs = [
              pkgs.bun
              pkgs.coreutils
              pkgs.nix
            ];
            text = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              exec bun "$PWD/scripts/deploy-bazantic-gateway.ts" "$@"
            '';
          };
          mcpCheck = pkgs.writeShellApplication {
            name = "mcp-check";
            runtimeInputs = [
              pkgs.bun
              pkgs.coreutils
              pkgs.jq
            ];
            text = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              exec bun "$PWD/scripts/mcp-check.ts" "$@"
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
            devPhysical
            startPhysical
            devEmulated
            startEmulated
            checkLocal
            ledgerBootstrap
            e2e
            e2eBazanticCanary
            e2eAll
            e2ePhysical
            deploy
            mcpCheck
            ;
          order-worker = orderWorker;
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
          let
            speculos = speculosPackage pkgs;
            securityKey = ledgerApp pkgs "security-key" ledger-security-key "";
            ledgerSyncApp = ledgerApp pkgs "ledger-sync" ledger-sync "";
            ethereumApp = ledgerApp pkgs "ethereum" ledger-ethereum "";
          in
          {
            inherit speculos;
            ledger-security-key = securityKey;
            ledger-sync = ledgerSyncApp;
            ledger-ethereum = ethereumApp;
            ledger-e2e-assets = pkgs.runCommand "ledger-e2e-assets" { } ''
              mkdir -p "$out/apps"
              cp ${securityKey}/share/ledger-apps/security-key.elf "$out/apps/security-key.elf"
              cp ${ledgerSyncApp}/share/ledger-apps/ledger-sync.elf "$out/apps/ledger-sync.elf"
              cp ${ethereumApp}/share/ledger-apps/ethereum.elf "$out/apps/ethereum.elf"
              cat > "$out/revisions.json" <<'EOF'
              ${builtins.toJSON ledgerRevision}
              EOF
            '';
          }
        )
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
          dev-emulated = {
            type = "app";
            program = "${packages.devEmulated}/bin/dev-emulated";
          };
          start-emulated = {
            type = "app";
            program = "${packages.startEmulated}/bin/start-emulated";
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
          e2e = {
            type = "app";
            program = "${packages.e2e}/bin/e2e";
          };
          e2e-bazantic-canary = {
            type = "app";
            program = "${packages.e2eBazanticCanary}/bin/e2e-bazantic-canary";
          };
          e2e-all = {
            type = "app";
            program = "${packages.e2eAll}/bin/e2e-all";
          };
          e2e-physical = {
            type = "app";
            program = "${packages.e2ePhysical}/bin/e2e-physical";
          };
          deploy = {
            type = "app";
            program = "${packages.deploy}/bin/deploy";
          };
          mcp-check = {
            type = "app";
            program = "${packages.mcpCheck}/bin/mcp-check";
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
            ! grep -RInE '(^|[^a-zA-Z0-9_-])(npm|npx|yarn|pnpm)([^a-zA-Z0-9_-]|$)' ${./scripts} ${./apps} ${./packages}
            touch $out
          '';
        }
      );

      devShells = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
          aube = aube171 pkgs;
          dev = self.packages.${system}.dev;
          start = self.packages.${system}.start;
          devEmulated = self.packages.${system}.devEmulated;
          startEmulated = self.packages.${system}.startEmulated;
          ledgerBootstrap = self.packages.${system}.ledgerBootstrap;
        in
        {
          default = pkgs.mkShell {
            LANG = "C.UTF-8";
            LC_ALL = "C.UTF-8";
            CXXFLAGS = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux "-std=c++17";
            packages = [
              aube
              dev
              start
              devEmulated
              startEmulated
              ledgerBootstrap
              self.packages.${system}.checkLocal
              self.packages.${system}.e2e
              self.packages.${system}.e2eBazanticCanary
              self.packages.${system}.e2eAll
              self.packages.${system}.e2ePhysical
              self.packages.${system}.deploy
              self.packages.${system}.mcpCheck
              pkgs.bun
              pkgs.nodejs
              # Build-time only: node-hid and usb may invoke node-gyp/prebuild-install.
              pkgs.gnumake
              pkgs.jq
              pkgs.git
              pkgs.openssl
              pkgs.postgresql_18
              pkgs.foundry
              pkgs.process-compose
              pkgs.turbo
              pkgs.nixfmt
            ]
            ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
              self.packages.${system}.speculos
              self.packages.${system}.ledger-e2e-assets
              pkgs.python3Packages.fido2
              pkgs.qemu-user
              pkgs.pkg-config
              pkgs.systemd
            ];
            shellHook = ''
              aube install
              export AQUA_ROOT="$PWD"
              export PATH="$PWD/node_modules/.bin:$PATH"
              export AQUA_UPSTREAM=${aqua}
              export SWAPVM_UPSTREAM=${swapvm}
              export X402_UPSTREAM=${x402}
              export PERMIT2_UPSTREAM=${permit2}
              export AQUA_SPECULOS_SOURCE=${speculos-src}
              export AQUA_PYTHON=${pkgs.python3.withPackages (ps: [ ps.fido2 ])}/bin/python3
                ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
                  export AQUA_SPECULOS_BIN=${self.packages.${system}.speculos}/bin/speculos
                  export AQUA_LEDGER_E2E_ASSETS=${self.packages.${system}.ledger-e2e-assets}
                  export AQUA_LEDGER_SECURITY_KEY_SOURCE=${ledger-security-key}
                ''}
              export AQUA_STATE_DIR="''${AQUA_STATE_DIR:-$PWD/.data}"
              export DATABASE_URL="''${DATABASE_URL:-postgresql://aqua:aqua@127.0.0.1:5432/aqua_backend}"
              mkdir -p "$AQUA_STATE_DIR"
            '';
          };
        }
      );
    };
}
