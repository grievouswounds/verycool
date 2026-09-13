# Aqua backend

An Aqua order-book and trading API implemented with `Bun.serve`. The canonical agent flow is an immutable preview followed by an x402 exact/Permit2-funded submission.

**Hosted MCP is custodial for the agent key.** Ledger FIDO2 on The Aqua Room proves who started the MCP Jam session. It does not gate decryption of the per-owner agent key. `AQUA_AGENT_KEK` plus a database dump can sign lifecycle and Permit2 payloads for every provisioned owner, within that owner's on-chain Policy. Caps expire in seven days. Compromise playbook: rotate the KEK (`kek_id` in `wrap_context`), revoke delegations on-chain, and reprovision. Do not treat hosted `/mcp` as non-custodial.

The local stdio bridge `aqua-ledger-key-ring` still keeps the agent key in Ledger Key Ring ciphertext on the laptop. `wallet-cli ring destroy` tears down the trustchain root (including Ledger Sync) and member rotation orphans old ciphertext.

Hosted Streamable HTTP `https://vercel-henna-gamma-46.vercel.app/mcp` (server name `aqua`) remains for `mcp-check hosted` / OAuth conformance. MCP Jam uses stdio `aqua-ledger-key-ring` only. Unique `*.vercel.app` deployment URLs fail WebAuthn.

It also monitors confirmed ERC-20 transfers for addresses selected by authenticated users. Collection is polling-based: a separate worker wakes every ten seconds and writes results to PostgreSQL; subscribing never opens a websocket.

## Technology stack

| Area | Technology |
| --- | --- |
| Runtime and HTTP | Bun with native `Bun.serve({ routes })` |
| Language | TypeScript 5.9 with the strictest compiler profile and zero first-party `any` |
| Validation and OpenAPI | Zod 4, OpenAPI 3.1, vendored Swagger UI |
| Ethereum | Cubane/Noble RPC, ABI, EIP-712, signing, recovery, and transaction primitives |
| Prices and quotes | Optional native-fetch 1inch spot prices and native SwapVM `eth_call` simulation |
| Authentication | Explicit SIWE parsing, EOA/EIP-1271 verification, PASETO `v4.public` with PASERK key rotation |
| Persistence | PostgreSQL and transactions |
| Background collection | Separate Bun activity and confirmed-block order workers |
| Conditional execution | Foundry contracts for intent nonces, persistent triggers, OCO closure, and bounded matching |
| Workspace | Aube dependency management and Turbo task orchestration |
| Reproducibility | One locked Nix flake and a native Nix development shell |
| Testing | Bun test, Anvil/Foundry protocol fixtures, strict type coverage |

## Quick start

Prerequisites are Nix with flakes enabled. The development shell provides Bun, Aube, PostgreSQL, Foundry/Anvil, Turbo, Process Compose, and Nix formatting tools; no local Bun or Aube installation is required. The emulated Ledger path on macOS and Windows uses Docker only as a Linux trampoline.

There are two local stacks. Both start PostgreSQL, Anvil, the x402 facilitator, the API, and both workers. Only the key-custody source differs. The emulated path is local-only and is never production.

Every operational command accepts the same Ledger flag:

- `--dev` or `--ledger emulator` — Speculos emulator signer (local development)
- `--prod` or `--ledger physical` — USB Ledger via node-HID (asks you to confirm on device)

`AQUA_LEDGER=emulator|physical` is the matching environment form. Unprefixed `dev` / `start` still default to a physical Ledger.

```sh
nix develop -c -- dev --prod
nix develop -c -- dev --dev
```

On the first physical-Ledger run, connect an unlocked Ledger and quit Ledger Live. The launcher provisions the service broker keys from the device. The API listens on `http://localhost:8787`; open Swagger at `http://localhost:8787/docs` or check readiness at `http://localhost:8787/health/ready`.

```sh
nix develop -c dev-emulated
```

The emulated stack uses Speculos and the pinned Ledger Sync ELF. On Apple Silicon it runs `docker compose up --build` so the Linux-only emulator is available; inside that container the same `nix develop -c dev-emulated` command starts the stack. Speculos's HTTP UI is published on host port `15000` (mapped to container `5000`) so it does not collide with macOS services on port 5000. Windows (Docker Desktop / WSL2) should clone the repository on the WSL2 filesystem, then:

```sh
docker compose up --build
```

Raise the WSL2 memory allocation before the first image build; Speculos and the Ledger apps compile from source. Persist `WALLET_PASS` across restarts in the container data volume so the keyring stays decryptable.

Both `nix develop -c -- dev --prod` and `nix run .#dev` use API hot reload on the physical path. Pass `--dev` for Speculos. Use `nix develop -c -- aqua-start --prod` for that stack without hot reload, and `nix develop -c start-emulated` (or `aqua-start --dev`) for the emulated equivalent. The same `--dev` / `--prod` flags apply to `deploy`, `ledger-bootstrap`, `e2e`, `mcp-check`, and `apps/mcp-bridge`. Run `nix develop -c ledger-bootstrap --prod` for explicit device diagnostics or recovery. Ledger SIWE enrollment is `bun scripts/enroll-ledger.ts`, not a Nix wrapper.

## Toolchain

- `nix develop` installs dependencies with Aube and exposes the complete toolchain without leaving background processes behind. The `dev`/`start` supervisor owns PostgreSQL initialization and migrations. Change dependencies only with Aube (`aube add`, `aube remove`); the lockfile is authoritative and produced by Aube 1.17.
- Run `aube run check` for strict TypeScript, 100% type coverage, zero-`any` AST inspection, ESLint, tests, dependency policy, and the production bundle.
- Run `aube run codegen:check` to verify the committed Cubane selector manifest.
- Enter the reproducible shell with `nix develop`. `dev --prod` and `nix develop -c -- dev --prod` launch the physical-Ledger hot-reload stack; `dev --dev` or `nix develop -c dev-emulated` launches the Speculos stack. `aqua-start --prod` launches the physical stack without hot reload. `aube run deploy --dev` or `deploy --prod` bundles the API and facilitator and deploys them to Vercel.

### Command reference

Dependency changes must use Aube:

```sh
aube install                       # install exactly from aube-lock.yaml
aube add -W package@version        # add a root runtime dependency
aube add -D -W package@version     # add a root development dependency
aube remove -W package             # remove a root dependency
```

Development and production:

```sh
aube run dev                       # complete local stack, API hot reload
aube run start                     # complete local stack, no hot reload
bun apps/worker/src/main.ts        # run the minute activity worker locally
bun apps/order-worker/src/main.ts  # run the confirmed order-book indexer locally
aube run build                     # build every Turbo workspace package
dev                                # same complete hot-reload stack
```

Quality and tests:

```sh
aube run test                      # all unit tests
aube run test:contracts            # offline Foundry security tests
aube run test:integration          # PostgreSQL/API integration tests
aube run test:protocol             # Anvil protocol tests
aube run typecheck                 # strict tsc plus 100% type coverage
aube run type-coverage             # type-coverage gate only
aube run lint                      # ESLint plus zero-any AST inspection
aube run policy                    # dependency policy plus zero-any policy
aube run codegen                   # regenerate committed Cubane selectors
aube run codegen:check             # fail when generated selectors are stale
aube run docs:check                # check OpenAPI/native-route synchronization
aube run check                     # complete local acceptance suite
aube run deploy                    # bundle API+facilitator, deploy to Vercel
aube run test:mcp                  # headless MCPJam checks against the hosted origin, stdio bridge, or both
aube run db:migrate                # apply PostgreSQL migrations
aube run identities                # print broker signer public identities
aube run test:e2e                  # deterministic Speculos e2e (same as `e2e`)
aube run test:e2e:hosted           # live hosted /mcp canary
aube run test:e2e:all              # emulator suite plus hosted canary
```

Nix:

```sh
nix flake check                    # evaluate and build checks for this system
nix develop                         # enter the complete native toolchain
nix develop -c -- dev --prod       # physical Ledger development stack
nix develop -c -- dev --dev        # Speculos development stack (Docker on macOS)
nix develop -c dev-emulated        # same as dev --dev
nix develop -c -- aqua-start --prod # physical Ledger stack, no hot reload
nix develop -c start-emulated      # Speculos stack, no hot reload
nix run .#dev                      # start the physical stack without entering a shell
nix run .#start                    # start the complete non-hot physical stack (`aqua-start`)
nix develop -c deploy              # same as aube run deploy
nix run .#deploy                   # publish the hosted API on Vercel
nix develop -c mcp-check hosted    # headless MCPJam doctor + tools/list against origin /mcp
nix run .#mcp-check                # same checks; pass hosted, bridge, or all
nix develop -c check-local         # local acceptance without the full e2e suite
nix run .#api -- --config /absolute/path/runtime-manifest.json # API only
nix build .#api                    # build the API launcher
nix build .#worker                 # build the activity-worker launcher
nix build .#order-worker           # build the order-book-worker launcher
```

The native packages and development shell are available on every supported flake system, including Apple Silicon macOS.

Cubane 0.3.12 is the first-party EVM boundary. The API, workers, contracts adapter, local LKRP signer, and x402 facilitator never import viem, ethers, web3, or the 1inch SDK. The pinned `@x402/evm` package currently retains viem internally, while Ledger's pinned device-management signer toolkit retains ethers internally; removing either from the transitive graph requires a maintained fork or replacement of the corresponding pinned package.

## API

All JSON request objects are strict: unknown keys are rejected. Amounts are canonical unsigned decimal strings. Addresses are 20-byte hexadecimal strings. Calldata, signatures, salts, and hashes are even-length `0x` byte strings. The deployment owns `CHAIN_ID`; request bodies cannot select a chain.

Authenticated endpoints require `Authorization: Bearer <access-token>`. Access tokens are short-lived, resource-bound PASETO `v4.public` tokens; refresh tokens remain opaque, single-use secrets in the secure `refresh_token` cookie. Authentication and scope failures include RFC 6750 `WWW-Authenticate` challenges. Errors use RFC 9457 `application/problem+json`, with structured validation issues for agents. The generated OpenAPI 3.1 document is served at `/openapi.json`; `/docs` serves interactive Swagger UI. Agent discovery of the seven MCP tools is the `.agents/skills/aqua-trading` skill. OpenAPI documents the `/v1/*` trading and auth routes; OAuth, MCP, Ledger FIDO2, and `/setup` are implemented but omitted from the OpenAPI document.

- `POST /v1/auth/challenges`: `{ "address": "0x…" }`
- `POST /v1/auth/sessions`: `{ "challengeId": "uuid", "message": "exact challenge message", "signature": "0x…" }` (issues `amr: ["siwe"]`; trading routes still require hardware AMR)
- Ledger FIDO2 ceremony under `/v1/auth/ledger/registration/{options,verify}` and `/v1/auth/ledger/authentication/{options,verify}`
- `POST /v1/agents/provision`: hardware-AMR Bearer; provisions the hosted agent vault
- `POST /v1/agents/me/challenges` and `PUT /v1/agents/me`: bind the local LKRP agent by EIP-712 proof of possession
- `POST /v1/delegations/previews` and `POST /v1/delegations`: prepare and relay bounded Ledger-owner policies
- `POST /v1/trade-previews`: resolve address/search/native token references and return an immutable five-minute plan with classification and RPC safety checks
- `POST /v1/trades`: submit `{previewId, previewHash, lifecycleSignature, additionalLifecycleSignatures?}` with `Idempotency-Key` equal to `previewId`; the first unpaid request returns HTTP 402 and an x402 v2 `payment-required` header for an exact Permit2 retry
- `GET /v1/trades`: select `own`, `subscriptions`, or `all`, with filters, stable sorting, and cursor pagination
- `POST /v1/trades/{tradeId}/cancellations` and `PUT /v1/trades/{tradeId}/cancellations/{cancellationId}`: start and sign a cancellation
- `POST /v1/trade-subscriptions`, `DELETE /v1/trade-subscriptions/{address}`, and `POST /v1/trade-subscriptions/trades/wipe`: manage subscribed-wallet trade projections
- `GET /setup?owner=0x…`: read-only hosted-owner status
- `POST /mcp`: hosted Streamable HTTP MCP (503 unless `AQUA_AGENT_KEK` is set)
- OAuth 2.1 + PKCE + dynamic registration: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/authorize`, `/register`, `/token`, and `/oauth/authorize/{start,complete}`

All trading amounts and prices are human decimal strings. Price always means quote-token units per one base token. The backend resolves ERC-20 decimals and converts to atomic integers with exact `bigint` arithmetic and maker-favouring rounding. Scientific notation, signs, separators, noncanonical zeroes, excess precision, unknown fields, duplicate keys, and prototype keys are rejected.

Supported MCP/trade policies are market, limit, stop-market, stop-limit, trailing-stop, take-profit market/limit, OCO, and bracket. The canonical `/v1/trades` route uses standard x402 v2 exact Permit2 funding. Swagger includes complete schemas and examples at `/docs`.

`payWithNative` prepares a wrapped-native deposit before the SwapVM call. The pinned SwapVM v1.0.2 `swap` entry point is non-payable, so the swap itself intentionally has zero native value. `receiveNative` uses the router unwrap trait and is restricted to the configured wrapped-native token.

## Hosted MCP (Acts 1–3)

Two Ledger apps, never at the same time. MCP Jam uses **stdio only** (`aqua-ledger-key-ring`). Hosted Streamable HTTP `/mcp` stays deployed for `mcp-check hosted` / OAuth conformance.

1. **Act 1 — once, USB, terminal.** `nix develop`, quit Ledger Live, `AQUA_API_URL=https://vercel-henna-gamma-46.vercel.app bun scripts/setup-hosted-owner.ts`. Ethereum app: SIWE. Security Key app: FIDO2 register **and immediately** FIDO2 authenticate (hardware PASETO). The script then `POST /v1/agents/provision`. Ethereum app again: one EIP-712 delegation per fixture token (`maxPerOrder = 1`, `maxPerDay = 100`, 7 days). Fund the printed agent. Optional `--fund`. Status: `GET /setup?owner=0x…` (read-only). Hosted AgentVault is not the Jam path.
2. **Act 2 — once per MCP Jam session.** Add one stdio server: `bun apps/mcp-bridge/src/main.ts --prod` with `AQUA_API_URL=https://vercel-henna-gamma-46.vercel.app`, `AQUA_RPC_URL`, and `XDG_STATE_HOME`. First tool call opens the Room in the default browser. Type the enrolled owner, Knock, confirm on the Security Key app. Loopback `http://127.0.0.1:$AQUA_OAUTH_CALLBACK_PORT/callback`. Device stays dark on market trades unless a 409 needs the Ethereum app. Set `AQUA_LEDGER_ORIGIN_TOKEN` for Clear Signing; after a 409 delegation retry, `post_trade` may include a `clearSigning` object from the Ledger reporter.
3. **Act 3 — every trade.** Chat `request_trade` then `post_trade` (same snake_case tools). Approve the preview. `post_trade` signs in the local LKRP keyring and pays Aqua Permit2 on the origin. You should see a trade record. A 409 `delegation-required` still uses the Ethereum app over USB.

## Local MCP bridge

`apps/mcp-bridge` exposes exactly `request_trade`, `post_trade`, `get_trades`, `cancel_trade`, `subscribe_to_user`, `unsubscribe_from_user`, and `wipe_subscribed_trades` over stdio. On first start its isolated signer runs `wallet-cli ring init` when required, creates a random secp256k1 agent key, and writes only LKRP ciphertext plus the public address. Decryption and signing happen only in the child signer process; plaintext key material is never printed or persisted. After authentication the bridge automatically proves possession of and binds that agent. Fund the displayed agent with native gas and sell assets, then register the suggested Ledger delegation before the first trade.

The bridge discovers the Bun API's OAuth metadata, registers a loopback client, opens the Ledger FIDO2 authorization ceremony in the browser, and stores its rotating refresh token in a mode-0600 local cache. Its audience is the Bun API resource URI, not a remote MCP URL. `AQUA_ACCESS_TOKEN` remains an explicit development override. Set `AQUA_API_URL` when it differs from `http://127.0.0.1:3000`; `AQUA_OAUTH_CALLBACK_PORT` defaults to `41739`. Optional `AQUA_AGENT_CIPHERTEXT`, `AQUA_AGENT_METADATA`, `AQUA_PREVIEW_CACHE`, and `AQUA_OAUTH_CACHE` paths relocate local state. Pass `--dev` for the Speculos signer or `--prod` for a physical Ledger; MCPJam should put the same flag in the stdio args (or set `AQUA_LEDGER`).

### x402 payments and Clear Signing

`packages/x402-client` is the bounded Permit2-paying HTTP client used by the stdio bridge and hosted `/mcp`. Aqua trade activation funds the exact Permit2 vault request on the deployment chain. Hosted callers without a delegated agent vault receive MCP JSON-RPC `-32042`. Discovery is the `.agents/skills/aqua-trading` skill rather than a marketplace listing.

`aube run deploy` (or `nix develop -c deploy`) bundles `apps/api` and `apps/facilitator` into `out/vercel` and deploys that artifact to Vercel. `AQUA_PUBLIC_ORIGIN` is the sole public host; the Aliased Vercel host must match it. MCP Jam uses stdio `aqua-ledger-key-ring`, not `{AQUA_PUBLIC_ORIGIN}/mcp`. `mcp-check bridge` is the Jam-shaped check; `mcp-check hosted` is origin `/mcp` doctor, tools/list, protocol, and OAuth conformance.

## Configuration

The API, workers, and facilitator load a Zod-validated runtime manifest (`schemaVersion: 1`, profile `local-anvil` or `production`) via `--config <runtime-manifest.json>` or the `AQUA_RUNTIME_MANIFEST` environment variable. Local Nix commands write `.data/runtime-manifest.json` automatically; they do not require a `.env` file.

The manifest owns chain identity (`chain.id`, `chain.rpcUrl`, `chain.genesisHash`, `chain.deploymentBlock`), service URLs (`services.databaseUrl`, `services.apiUrl`, `services.facilitatorUrl`, `services.brokerSocket`), SIWE/WebAuthn identity (`auth.issuer`, `auth.resource`, `auth.rpId`, `auth.origin`, `auth.pasetoPublicKeys`), every contract address plus runtime-code hash, fixture tokens and pairs, indexer start block / confirmations / allowlisted contracts, and keeper target+selector policy. Secret material is referenced as `broker://agent|facilitator|keeper|paseto`, never as raw keys in the manifest. Startup proves the broker's PASETO public key matches `auth.pasetoPublicKeys[0]`, then blocks ready until every contract's on-chain code hash matches.

Copy [`.env.example`](.env.example) only for optional interactive overrides. It currently documents `AQUA_LOG_LEVEL`, `AQUA_STATE_DIR`, optional 1inch settings, the already-deployed Sepolia contract addresses used by `bun scripts/deploy-public-chain.ts`, and the hosted env-signer keys (`AQUA_AGENT_KEY`, `AQUA_FACILITATOR_KEY`, `AQUA_KEEPER_KEY`, `PASETO_V4_SECRET_KEY`, `DATABASE_URL`). Those last four plus `AQUA_SIGNER=env` are how Vercel signs without a Unix-socket broker.

Rotate access-token keys by deploying the new `k4.public` PASERK into `auth.pasetoPublicKeys` first, then switching the active `k4.secret` while retaining the old public key. Remove the retiring public key only after the maximum access-token lifetime has elapsed. The issuer and verifier are separate so a future HTTP MCP resource server can validate audience-bound Bearer tokens without receiving signing material. Hardware OAuth tokens carry `amr: ["fido2","hwk"]`; SIWE sessions carry `amr: ["siwe"]` and cannot call trading routes.

Confirmations live in `indexer.confirmations` and must be chosen for the configured chain. The activity worker defaults to a 10-second interval, 1,000-block chunks, four concurrent subscriptions, a 120-second lease, and 100 active subscriptions per authenticated wallet. The order-worker defaults to a 2-second poll and 500-block chunks. The worker and API must use the same RPC, PostgreSQL database, chain, and confirmation configuration.

`dev` and `aqua-start` persist PostgreSQL, Anvil state, deployment evidence, encrypted keys, and the verified runtime manifest under the gitignored `.data` directory. The local chain is fixed to chain ID 31337. Its manifest contains Aqua, both SwapVM routers, WETH9, the intent controller, vault factory, BoundedMatcher, canonical Permit2, canonical x402 exact proxy, and two differently-decimalled fixture tokens. Startup blocks the API until code hashes, constructor bindings, operators, matcher permissions, fixture metadata/supply, seed receipts, and canonical addresses all verify.

## Public / Sepolia deploy

`bun scripts/deploy-public-chain.ts` writes `.data/runtime-manifest.production.json` (`profile: "production"`). The Sepolia Aqua, SwapVM routers, intent controller, vault factory, BoundedMatcher, and fixture tokens in [`.env.example`](.env.example) are already deployed; the script reuses them unless evidence is stale. It needs `DATABASE_URL`, `AQUA_DEPLOYER_PRIVATE_KEY`, `AQUA_AGENT_KEY`, `AQUA_FACILITATOR_KEY`, `AQUA_KEEPER_KEY`, `PASETO_V4_SECRET_KEY`, and the pinned upstream repo URLs (`AQUA_UPSTREAM`, `SWAPVM_UPSTREAM`, `X402_UPSTREAM`, `PERMIT2_UPSTREAM`). `AQUA_PUBLIC_ORIGIN` (or `AQUA_VERCEL_URL`) becomes the auth issuer/origin in that manifest.

`aube run deploy` (or `nix develop -c deploy`) then bundles `apps/api` and `apps/facilitator` into `out/vercel` and deploys that artifact. `AQUA_PUBLIC_ORIGIN` is the sole public host; the Aliased Vercel host must match it. Unique `*.vercel.app` deployment URLs fail WebAuthn. The hosted process sets `AQUA_SIGNER=env` and signs with the env keys above; `AQUA_AGENT_KEK` is required for `/mcp`. MCP Jam still uses stdio `aqua-ledger-key-ring`, not `{AQUA_PUBLIC_ORIGIN}/mcp`.

## Speculos end-to-end evidence

Run `nix develop -c e2e` for the deterministic Linux suite, `nix develop -c e2e-physical` against a connected Ledger (no Speculos, `node-hid`, operator-confirmed screens), `nix develop -c e2e-hosted-mcp-canary` for the live hosted `/mcp` catalog check, or `nix develop -c e2e-all` for both emulator checks. On macOS the emulator command enters a Linux container whose test environment is still constructed by `nix develop`; Linux runs directly. Physical mode skips that trampoline because node-HID works natively. The deterministic suite builds pinned Nano S+ Ledger Sync, Ethereum, and Security Key applications, runs Ledger Sync, Ethereum, and Security Key in Speculos (Ethereum HTTP 5000 / APDU 9999 and Security Key on its own HTTP port with APDU 5001 `--usb U2F` concurrently during MCP), deploys the pinned upstream Aqua/SwapVM contracts on an isolated Anvil chain, and writes code, receipt, call-trace, APDU, FIDO2 OAuth, and tool-catalog evidence under `reports/e2e/`. Ethereum signing uses the production Device Management Kit path; Speculos `/automation` approves on-device review screens. The Security Key phase talks CTAPHID on Speculos `--apdu-port 5001` and completes the real OAuth 2.1 + Ledger FIDO2 ceremony (no `AQUA_ACCESS_TOKEN` bypass).

The hosted MCP canary requires `AQUA_PUBLIC_ORIGIN`. It calls origin `/mcp` `tools/list` and fingerprints the seven canonical tools. Aqua x402 remains exact Permit2 funding in the trade's sell token on the deployment chain.

Speculos executes real Ledger application binaries and is suitable for application protocol and cryptographic-flow testing. It does not emulate physical USB, Ledger firmware, the Secure Element, or hardware security properties, so a passing suite is not a hardware-attestation claim. Production continues to use node-HID and the released `wallet-cli`; the Speculos transport, test attestation material, and wallet adapter require `AQUA_E2E=1`.

The deployment is reused only when the entire recorded set and both deterministic seeded orders remain valid. Missing code, stale runtime hashes, wrong bindings, or incomplete evidence cause a complete redeployment and regenerated manifest. An incomplete `.data/keyring` is never overwritten: move it aside for forensic recovery or restore all four `agent.enc`, `facilitator.enc`, `keeper.enc`, and `paseto.enc` files, then run `ledger-bootstrap` again. For API-only operation, bypass the local supervisor explicitly with `nix run .#api -- --config <runtime-manifest.json>`.

Set `ONEINCH_API_KEY` to enable authenticated 1inch spot prices inside trade previews. There is no public `/v1/prices` or `/v1/quotes` HTTP route. `ONEINCH_BASE_URL` defaults to `https://api.1inch.com` and `ONEINCH_DEFAULT_CURRENCY` defaults to `USD`. These settings do not affect Aqua quote/trade readiness; local Anvil chains are normally unsupported by the external price provider.

The order-worker scans `indexer.contracts` from `indexer.startBlock` and projects only the fixture pairs in `fixtures.pairs`. It decodes Aqua `Shipped`, `Docked`, `Pushed`, and `Pulled` plus SwapVM `Swapped`; only `Shipped`, `Docked`, and `Swapped` are written into the public book. Only a decoded SwapVM order matching the backend's exact limit-grammar recognizer is projected. Orders, fills, human-decimal prices, remaining balances, raw evidence, and the canonical checkpoint are committed transactionally. A changed checkpoint hash causes deterministic rewind and replay.

Market execution walks price-time-compatible liquidity in best-price order and is bounded to eight Aqua orders. FOK requires sufficient full-depth liquidity; IOC reports any unfilled human-decimal amount. Post-only and book-or-cancel reject crossing placement. Ticker, recent trades, candles, balances, Aqua virtual allocations, and open-order commitments are computed from the same confirmed projection.

On the local stack, keeper signing is isolated in the Unix-socket secret broker. Its encrypted key is decrypted by `wallet-cli` and never enters an environment variable, image, API request, or log. Hosted Vercel uses `AQUA_SIGNER=env` instead and keeps those keys in process environment. The generated manifest restricts it to the intent controller’s `observe`/`activate`, vault-factory lifecycle `execute`, and BoundedMatcher batch `execute`; the matcher separately permits only `swap` on the two deployed routers. The worker serializes nonces through leased PostgreSQL jobs, enforces gas and fee ceilings, follows receipts, and records terminal reverts.

The contracts in [`contracts/`](contracts/) are security-sensitive reference implementations, not an audit. `AquaIntentController` provides EIP-712 nonce consumption and block-plus-time trigger persistence; `BoundedMatcher` caps execution at eight allowlisted target-selector calls. Production use requires an independent audit and reviewed router/program allowlists. Arbitrary Aqua programs are excluded because SwapVM instruction ordering is security-critical.

The exact accepted input languages and trust boundaries are documented in [`docs/LANGSEC.md`](docs/LANGSEC.md).
