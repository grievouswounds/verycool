{
  description = "Native Bun Aqua transaction-preparation backend";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
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
        pkgs.stdenvNoCC.mkDerivation {
          pname = name;
          version = "0.1.0";
          src = source;
          dontBuild = true;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            mkdir -p $out/lib/${name} $out/bin
            cp main.js $out/lib/${name}/main.js
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/${name} --add-flags "$out/lib/${name}/main.js"
          '';
        };
      devStack =
        pkgs: aube:
        let
          processComposeConfig = pkgs.writeText "aqua-process-compose.yaml" ''
            version: "0.5"
            ordered_shutdown: true

            processes:
              postgresql:
                command: >-
                  postgres -D "$${AQUA_STATE_DIR}/postgresql"
                readiness_probe:
                  exec:
                    command: pg_isready -h 127.0.0.1 -p 5432 -d aqua_backend
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

              api:
                command: bun --hot "$${AQUA_ROOT}/apps/api/src/main.ts"
                depends_on:
                  postgres-init:
                    condition: process_completed_successfully
                availability:
                  restart: on_failure
                  backoff_seconds: 2

              activity-worker:
                command: bun "$${AQUA_ROOT}/apps/worker/src/main.ts"
                depends_on:
                  postgres-init:
                    condition: process_completed_successfully
                availability:
                  restart: on_failure
                  backoff_seconds: 2

              order-worker:
                command: bun "$${AQUA_ROOT}/apps/order-worker/src/main.ts"
                depends_on:
                  postgres-init:
                    condition: process_completed_successfully
                availability:
                  restart: on_failure
                  backoff_seconds: 2
          '';
        in
        pkgs.writeShellApplication {
          name = "dev";
          runtimeInputs = [
            aube
            pkgs.bun
            pkgs.postgresql_18
            pkgs.process-compose
          ];
          text = ''
            if [ ! -f .env ]; then
              echo "Missing .env. Copy .env.example to .env and configure it before starting the development stack." >&2
              exit 1
            fi

            export AQUA_ROOT="$PWD"
            export AQUA_STATE_DIR="$PWD/.data"
            export DATABASE_URL="''${DATABASE_URL:-postgresql://aqua:aqua@127.0.0.1:5432/aqua_backend}"
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
          api = appProgram pkgs "aqua-api" ./apps/api/dist;
          worker = appProgram pkgs "aqua-activity-worker" ./apps/worker/dist;
          orderWorker = appProgram pkgs "aqua-order-worker" ./apps/order-worker/dist;
          dev = devStack pkgs aube;
        in
        {
          default = api;
          inherit
            aube
            api
            worker
            dev
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
          worker = {
            type = "app";
            program = "${packages.worker}/bin/aqua-activity-worker";
          };
          order-worker = {
            type = "app";
            program = "${packages.order-worker}/bin/aqua-order-worker";
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
            ! grep -E '(^|[/@])(viem|ethers|web3)(@|:)' ${./aube-lock.yaml}
            touch $out
          '';
        }
      );

      devShells = eachSystem (
        system:
        let
          pkgs = pkgsFor system;
          aube = aube171 pkgs;
          dev = devStack pkgs aube;
        in
        {
          default = pkgs.mkShell {
            packages = [
              aube
              dev
              pkgs.bun
              pkgs.nodejs
              pkgs.postgresql_18
              pkgs.foundry
              pkgs.process-compose
              pkgs.turbo
              pkgs.nixfmt
            ];
            shellHook = ''
              aube install
              export AQUA_ROOT="$PWD"
              export AQUA_STATE_DIR="$PWD/.data"
              export DATABASE_URL="''${DATABASE_URL:-postgresql://aqua:aqua@127.0.0.1:5432/aqua_backend}"
              mkdir -p "$AQUA_STATE_DIR"
              if ! pg_isready -h 127.0.0.1 -p 5432 -d postgres >/dev/null 2>&1; then
                if [ ! -d "$AQUA_STATE_DIR/postgresql" ]; then
                  initdb -D "$AQUA_STATE_DIR/postgresql" --auth=trust
                fi
                pg_ctl -D "$AQUA_STATE_DIR/postgresql" -l "$AQUA_STATE_DIR/postgresql.log" start
              fi
              createuser -h 127.0.0.1 aqua 2>/dev/null || true
              createdb -h 127.0.0.1 -O aqua aqua_backend 2>/dev/null || true
              bun "$AQUA_ROOT/scripts/migrate.ts"
            '';
          };
        }
      );
    };
}
