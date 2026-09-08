# Aqua backend

A non-custodial, chain-wide Aqua order-book API implemented directly with `Bun.serve`. One agent-first business endpoint prepares user-signed transactions, queries compatible indexed liquidity, and accepts narrowly scoped `aqua-intent-v1` authorizations for conditional keeper work. User keys never enter the service.

It also monitors confirmed ERC-20 transfers for addresses selected by authenticated users. Collection is polling-based: a separate worker wakes once per minute and writes results to PostgreSQL; subscribing never opens a websocket.

## Technology stack

| Area | Technology |
| --- | --- |
| Runtime and HTTP | Bun with native `Bun.serve({ routes })` |
| Language | TypeScript 5.9 with the strictest compiler profile and zero first-party `any` |
| Validation and OpenAPI | Zod 4, OpenAPI 3.1, vendored Swagger UI |
| Ethereum | Cubane, Noble JavaScript crypto adapters, native-fetch EIP-1474 RPC |
| Prices and quotes | Optional native-fetch 1inch spot prices and native SwapVM `eth_call` simulation |
| Authentication | Explicit SIWE parsing, EOA/EIP-1271 verification, PASETO `v4.public` with PASERK key rotation |
| Persistence | PostgreSQL and transactions |
| Background collection | Separate Bun activity and confirmed-block order workers |
| Conditional execution | Foundry contracts for intent nonces, persistent triggers, OCO closure, and bounded matching |
| Workspace | Aube dependency management and Turbo task orchestration |
| Reproducibility | One locked Nix flake and a native Nix development shell |
| Testing | Bun test, Anvil/Foundry protocol fixtures, strict type coverage |

## Quick start

Prerequisites are Nix with flakes enabled. The development shell provides Bun, Aube, PostgreSQL, Foundry/Anvil, Turbo, Process Compose, and Nix formatting tools; no local Docker, Bun, or Aube installation is required.

```sh
nix develop -c dev
```

On the first run, connect an unlocked Ledger with its Ethereum app open and quit Ledger Live. The launcher verifies the device, prompts twice for a new local keyring password when the `aqua-ledger-wallet-pass` Keychain item is absent, and atomically creates four encrypted keys in `.data/keyring`. It then starts PostgreSQL and Anvil, deploys and verifies every protocol contract, seeds deterministic two-way fixture liquidity, and starts the API and both workers. The API listens on `http://localhost:8787`; open Swagger at `http://localhost:8787/docs` or check readiness at `http://localhost:8787/health/ready`.

Both `nix develop -c dev` and `nix run .#dev` use API hot reload. Use `aube run start` or `nix run .#start` for the same complete stack without hot reload. Run `ledger-bootstrap` inside the development shell for explicit device diagnostics or recovery.

## Toolchain

- `nix develop` installs dependencies with Aube and exposes the complete toolchain without leaving background processes behind. The `dev`/`start` supervisor owns PostgreSQL initialization and migrations. Change dependencies only with Aube (`aube add`, `aube remove`); the lockfile is authoritative and produced by Aube 1.17.
- Run `aube run check` for strict TypeScript, 100% type coverage, zero-`any` AST inspection, ESLint, tests, dependency policy, and the production bundle.
- Run `aube run codegen:check` to verify the committed Cubane selector manifest.
- Enter the reproducible shell with `nix develop`. `aube run dev`, `dev`, and `nix develop -c dev` all launch the complete hot-reload stack; `aube run start` launches its non-hot equivalent.

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
```

Nix:

```sh
nix flake check                    # evaluate and build checks for this system
nix develop                         # enter the complete native toolchain
nix develop -c dev                 # start the native development stack
nix run .#dev                      # start the same stack without entering a shell
nix run .#start                    # start the complete non-hot stack
nix run .#api -- --config /absolute/path/runtime-manifest.json # API only
nix build .#api                    # build the API launcher
nix build .#worker                 # build the activity-worker launcher
nix build .#order-worker           # build the order-book-worker launcher
```

The native packages and development shell are available on every supported flake system, including Apple Silicon macOS.

Cubane 0.3.12 is pinned because it was the current registry release at implementation time. A small committed declaration patch contains its unsafe third-party declaration surface; all values crossing that boundary are validated before becoming first-party branded types. No viem, ethers, web3, or 1inch SDK package is installed.

## API

All JSON request objects are strict: unknown keys are rejected. Amounts are canonical unsigned decimal strings. Addresses are 20-byte hexadecimal strings. Calldata, signatures, salts, and hashes are even-length `0x` byte strings. The deployment owns `CHAIN_ID`; request bodies cannot select a chain.

Authenticated endpoints require `Authorization: Bearer <access-token>`. Access tokens are short-lived, resource-bound PASETO `v4.public` tokens; refresh tokens remain opaque, single-use secrets in the secure `refresh_token` cookie. Authentication and scope failures include RFC 6750 `WWW-Authenticate` challenges. Errors use RFC 9457 `application/problem+json`, with structured validation issues for agents. The generated OpenAPI 3.1 document is served at `/openapi.json`; `/docs` serves interactive Swagger UI. `/v1/capabilities` gives agents a compact description of grammars, alternatives, defaults, and supported order policies.

- `POST /v1/auth/challenges`: `{ "address": "0x…" }`
- `POST /v1/auth/sessions`: `{ "challengeId": "uuid", "message": "exact challenge message", "signature": "0x…" }`
- `POST /v1/auth/refresh`: no body; rotates the secure `refresh_token` cookie.
- `POST /v1/trading`: the sole trading business route. Its `action` selects `createOrder`, `amendOrder`, `cancelOrders`, `executeOrder`, `prepareSwap`, `batch`, `query`, or `manageWrappedNative`. Nested discriminators make incompatible combinations unrepresentable.
- `GET /v1/prices/address/{address}` and `GET /v1/prices/name/{name}`: authenticated deployment-chain spot prices. These return `503` when `ONEINCH_API_KEY` is not configured.
- `POST /v1/quotes/aqua`: authenticated, read-only exact-input or exact-output simulation for one encoded Aqua order.

`POST /v1/trading` also accepts `prepareSwap` for raw encoded orders. It quotes and simulates with the authenticated wallet as taker, then returns only unsigned approval, wrapping, and swap transactions; the API never accepts a wallet key or broadcasts on the caller's behalf.

```json
{"routerKind":"aquaLimit","encodedOrder":"0x…","tokenIn":"0x1111111111111111111111111111111111111111","tokenOut":"0x2222222222222222222222222222222222222222","amountIn":"1"}
```

```json
{"action":"prepareSwap","swap":{"routerKind":"aquaLimit","encodedOrder":"0x…","tokenIn":"0x1111111111111111111111111111111111111111","tokenOut":"0x2222222222222222222222222222222222222222","amountIn":"1","slippageBps":"50"}}
```

All trading amounts and prices are human decimal strings. Price always means quote-token units per one base token. The backend resolves ERC-20 decimals and converts to atomic integers with exact `bigint` arithmetic and maker-favouring rounding. Scientific notation, signs, separators, noncanonical zeroes, excess precision, unknown fields, duplicate keys, and prototype keys are rejected.

```json
{"action":"createOrder","order":{"kind":"limit","pair":{"baseToken":"0x1111111111111111111111111111111111111111","quoteToken":"0x2222222222222222222222222222222222222222"},"side":"sell","size":{"denomination":"base","amount":"1.5"},"limitPrice":"2500"}}
```

```json
{"action":"query","query":{"resource":"orderBook","pair":{"baseToken":"0x1111111111111111111111111111111111111111","quoteToken":"0x2222222222222222222222222222222222222222"},"depth":"20"}}
```

Supported orders are market, limit, stop-market, stop-limit, trailing-stop, take-profit market/limit, OCO, and bracket. Policies include GTC, GTD, IOC, FOK, partial, all-or-none, post-only, and book-or-cancel. Queries cover orders, fills, book depth, ticker, recent trades, candles, balances, and fees. Batches are capped at 20 operations.

Conditional commands use the custom `aqua-intent-v1` challenge/retry profile. An unsigned request returns `402` and `AQUA-AUTHORIZATION-REQUIRED`. Sign the returned EIP-712 value and repeat the identical command with a base64url `AQUA-AUTHORIZATION` header containing `authorizationId` and `signature`. Success returns `202` and `AQUA-AUTHORIZATION-RESPONSE`. This grants narrow trading authority; it is not an x402 payment and does not replace SIWE authentication.

Legacy trading routes were removed in API v1. Migrate them to the corresponding `/v1/trading` action. Swagger includes complete schemas and examples at `/docs`; `/v1/capabilities` is the compact machine-readable discovery surface.

### ERC-20 monitoring

All monitoring operations require a bearer access token. Subscriptions belong to the authenticated wallet, even when it monitors an unrelated public address.

```http
POST /v1/erc20-monitor/subscriptions
Content-Type: application/json

{"address":"0x1111111111111111111111111111111111111111"}
```

The first scan includes the preceding minute at the configured confirmation depth. Repeating the request is idempotent. List subscriptions with `GET /v1/erc20-monitor/subscriptions` and stop future collection with `DELETE /v1/erc20-monitor/subscriptions/{address}`. Unsubscribing retains collected actions.

Use `GET /v1/erc20-monitor/actions` for all subscriptions, or add `address`, `classification`, `from`, `to`, `cursor`, and `limit` query parameters. Limits default to 50 and cannot exceed 200. On-chain amounts, block numbers, log indexes, confirmations, and deletion counts are returned as decimal strings.

Wiping is deliberately explicit:

```json
{"scope":"address","address":"0x1111111111111111111111111111111111111111"}
```

or:

```json
{"scope":"all","confirmation":"WIPE_ALL_ERC20_ACTIVITY"}
```

Send either body to `POST /v1/erc20-monitor/actions/wipe`. A pure incoming transfer is `received`, not automatically a `buy`. Buy/sell labels are emitted only when a transaction contains opposite-direction transfers of different ERC-20 tokens involving the watched address, and carry `classificationSource: "inferredCounterflow"`. Native-currency counterflows are not guessed.

`payWithNative` prepares a wrapped-native deposit before the SwapVM call. The pinned SwapVM v1.0.2 `swap` entry point is non-payable, so the swap itself intentionally has zero native value. `receiveNative` uses the router unwrap trait and is restricted to the configured wrapped-native token.

## Configuration

Copy `.env.example` to `.env` and provide chain-specific contracts, RPC, PostgreSQL `DATABASE_URL`, SIWE identity, an absolute `AUTH_ISSUER`, and the canonical `AUTH_RESOURCE` URI used as the token audience. `PASETO_V4_SECRET_KEY` is the active `k4.secret` PASERK; `PASETO_V4_PUBLIC_KEYS` is a JSON array containing its matching `k4.public` PASERK and any retiring verification keys. Startup derives standard `k4.pid` identifiers, rejects malformed or duplicate keys, and proves that the active secret matches exactly one public key before serving requests.

Rotate access-token keys by deploying the new public key to every verifier first, then switching the active secret key while retaining the old public key. Remove the retiring public key only after the maximum access-token lifetime has elapsed. The issuer and verifier are separate components so a future HTTP MCP resource server can validate audience-bound Bearer tokens without receiving signing material. OAuth 2.1 endpoints, PKCE, and protected-resource discovery are intentionally deferred until an MCP endpoint is added.

`ACTIVITY_CONFIRMATIONS` is required and must be chosen for the configured chain. Collection defaults to a 60-second interval, 1,000-block chunks, four concurrent subscriptions, a 120-second lease, and 100 active subscriptions per authenticated wallet. The worker and API must use the same RPC, PostgreSQL database, chain, and confirmation configuration.

`dev` and `start` persist PostgreSQL, Anvil state, deployment evidence, encrypted keys, and the verified runtime manifest under the gitignored `.data` directory. The local chain is fixed to chain ID 31337. Its manifest contains Aqua, both SwapVM routers, WETH9, the intent controller, vault factory, BoundedMatcher, canonical Permit2, canonical x402 exact proxy, and two differently-decimalled fixture tokens. Startup blocks the API until code hashes, constructor bindings, operators, matcher permissions, fixture metadata/supply, seed receipts, and canonical addresses all verify.

The deployment is reused only when the entire recorded set and both deterministic seeded orders remain valid. Missing code, stale runtime hashes, wrong bindings, or incomplete evidence cause a complete redeployment and regenerated manifest. An incomplete `.data/keyring` is never overwritten: move it aside for forensic recovery or restore all four `agent.enc`, `facilitator.enc`, `keeper.enc`, and `paseto.enc` files, then run `ledger-bootstrap` again. For API-only operation, bypass the local supervisor explicitly with `nix run .#api -- --config <runtime-manifest.json>`.

Set `ONEINCH_API_KEY` to enable the authenticated price endpoints. `ONEINCH_BASE_URL` defaults to `https://api.1inch.com` and `ONEINCH_DEFAULT_CURRENCY` defaults to `USD`. These settings do not affect Aqua quote/trade readiness; local Anvil chains are normally unsupported by the external price provider.

`ORDERBOOK_CONTRACTS` is a strict JSON array of allowlisted contracts scanned from `ORDERBOOK_START_BLOCK`; `ORDERBOOK_PAIRS` is the bounded base/quote registry. The worker recognizes the exact current Aqua `Shipped`, `Docked`, `Pushed`, and `Pulled` events and SwapVM `Swapped` event. Only a decoded SwapVM order containing the backend's exact five-instruction limit grammar is projected into the public book. Orders, fills, human-decimal prices, remaining balances, raw evidence, and the canonical checkpoint are committed transactionally. A changed checkpoint hash causes deterministic rewind and replay.

Market execution walks price-time-compatible liquidity in best-price order and is bounded to eight Aqua orders. FOK requires sufficient full-depth liquidity; IOC reports any unfilled human-decimal amount. Post-only and book-or-cancel reject crossing placement. Ticker, recent trades, candles, balances, Aqua virtual allocations, and open-order commitments are computed from the same confirmed projection.

Keeper signing is isolated in the local Unix-socket secret broker. Its encrypted key is decrypted by `wallet-cli` and never enters an environment variable, image, API request, or log. The generated manifest restricts it to the intent controller’s `observe`/`activate`, vault-factory lifecycle `execute`, and BoundedMatcher batch `execute`; the matcher separately permits only `swap` on the two deployed routers. The worker serializes nonces through leased PostgreSQL jobs, enforces gas and fee ceilings, follows receipts, and records terminal reverts.

The contracts in [`contracts/`](contracts/) are security-sensitive reference implementations, not an audit. `AquaIntentController` provides EIP-712 nonce consumption and block-plus-time trigger persistence; `BoundedMatcher` caps execution at eight allowlisted target-selector calls. Production use requires an independent audit and reviewed router/program allowlists. Arbitrary Aqua programs are excluded because SwapVM instruction ordering is security-critical.

The exact accepted input languages and trust boundaries are documented in [`docs/LANGSEC.md`](docs/LANGSEC.md).
