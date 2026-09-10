<h1 align="center">Speakeasy</h1>

<h4 align="center">
  Non-custodial 1inch Aqua trading for AI agents, with keys that never leave Ledger
  <p align="center">
    <img src="./assets/speakeasy.png" alt="Speakeasy" width="320" />
  </p>
  <a href="https://github.com/grievouswounds/verycool">GitHub</a>
</h4>

Speakeasy is a **back-end for agents that trade on [1inch Aqua](https://github.com/1inch/aqua) / SwapVM** without ever handing the HTTP API a private key. An MCP stdio bridge talks to the agent. A Ledger Key Ring (`wallet-cli ring`) encrypts the agent, facilitator, keeper, and PASETO material. The Bun API only prepares immutable previews, verifies proofs, and returns unsigned (or x402-gated) transactions. Settlement is on-chain: Aqua registry, SwapVM routers, canonical Permit2, and x402 exact Permit2.

The product is the **speakeasy in the middle**: agents get a machine-readable order book and trade grammar; humans keep hardware custody and FIDO2 login; the chain stays the source of truth.

- 🔐 **Keys stay on Ledger.** Secret-broker decrypts over a Unix socket via `wallet-cli`. Plaintext never hits env vars, logs, or JSON bodies.
- 🧠 **Agents speak MCP, not wallets.** `request_trade` → immutable preview → `post_trade` with x402 exact Permit2. The API broadcasts nothing with the user's key.
- 📒 **Official Aqua / SwapVM, not a fork of the matching engine.** Limit programs use the pinned five-instruction grammar. Quotes are SwapVM `eth_call`, not the 1inch SDK.
- ⛓️ **Off-chain book, on-chain evidence.** Workers index `Shipped` / `Docked` / `Pushed` / `Pulled` and SwapVM `Swapped` into Postgres. The keeper may only hit allowlisted selectors on the intent controller, vault factory, and `BoundedMatcher`.
- 🪪 **Hardware AMR.** OAuth 2.1 + PKCE + Ledger Security Key (FIDO2). Access tokens are PASETO `v4.public` with `amr: ["fido2","hwk"]`.

## How it works

1. **Enroll.** `ledger-bootstrap` (physical `--prod` or Speculos `--dev`) creates LKRP-encrypted `agent` / `facilitator` / `keeper` / `paseto` keys. The secret broker writes `identity.json` (public addresses only).
2. **Bind.** The MCP bridge proves possession of the agent (EIP-712) and the owner registers a **bounded delegation** (spend ceilings, allowed routers).
3. **Preview.** `POST /v1/trade-previews` resolves tokens, classifies the intent, and returns a **five-minute immutable plan** plus RPC safety checks. The hash is what gets signed.
4. **Pay + ship.** `POST /v1/trades` first returns x402 `PAYMENT-REQUIRED` (exact Permit2 on the **deployment chain**, any standard ERC-20 sell token). Retry settles the vault; Aqua `ship` / SwapVM run on-chain.
5. **Index + keep.** Order worker projects the book from confirmed logs. Conditional orders (stop, trailing, OCO, bracket) fire through `AquaIntentController` + `BoundedMatcher` (max eight allowlisted calls).

Local Anvil is chain **31337**. Live demo target is Ethereum **Sepolia (11155111)** with the vanity Aqua registry where it already exists, plus routers and intent contracts this repo deploys.

## Architecture

| Layer | What it is |
| --- | --- |
| Agent | MCP client (`request_trade`, `post_trade`, `get_trades`, `cancel_trade`, subscriptions) |
| MCP bridge | stdio; OAuth loopback; isolated signer child; LKRP ciphertext on disk |
| Bun API | `Bun.serve`, OpenAPI 3.1, `/docs`, RFC 9457 errors, strict Zod bodies |
| Secret broker | Unix socket; `wallet-cli` decrypt/sign; keeper allowlist from the runtime manifest |
| Facilitator | Local x402 exact settlement for Anvil / the configured chain |
| Postgres | Sessions, activity, order projection, keeper leases |
| Workers | ERC-20 monitor (poll, not websocket); order indexer + keeper |
| Chain | Aqua, `AquaSwapVMRouter`, `LimitSwapVMRouter`, Permit2 `0x000000000022D473…`, x402 exact `0x402085c2…`, WETH, intent/vault/`BoundedMatcher` |

Trust boundary: the API is a **language recognizer** (see [`docs/LANGSEC.md`](docs/LANGSEC.md)). Unknown JSON keys, non-canonical decimals, and off-allowlist calldata are rejected. Cubane is the first-party EVM stack (no first-party viem / ethers / 1inch SDK).

## Bounties

### Ledger — AI Agents × Ledger

The agent key is born inside LKRP, not in the API process. Physical path: Ledger Sync + Ethereum (blind signing) + Security Key, Device Management Kit, `node-hid`, operator-confirmed screens. Emulated path: Speculos + pinned ELFs (`AQUA_E2E=1`) for protocol tests — **not** a Secure Element claim.

### 1inch — Build an Aqua App

Uses official Aqua + SwapVM (Nix-pinned sources), on-chain Anvil and Sepolia, git history in this repo. Limit flow is SwapVM opcode programs (`LimitSwapVMRouter`), not a Solidity `AquaApp` wrapper. Local forks and fixture ERC-20s (`aUSD` / `aETH`) are for the demo book.

### Bazantic (honest scope)

Catalog discovery and `tools/list` exist. A **public Agentify gateway** still needs HTTPS OpenAPI and a reachable origin; `aube run deploy` can draft a Vercel + Bazantic listing. Ordinary MCP clients cannot settle Bazantic `402` (Base USDC). Aqua x402 stays on the **Aqua deployment chain**.

## Getting started

**Need:** Nix with flakes. The shell brings Bun, Aube, Postgres, Foundry, Process Compose. No global Bun install.

Two stacks share API, workers, Postgres, and facilitator. Only custody differs.

| Flag | Meaning |
| --- | --- |
| `--dev` / `--ledger emulator` | Speculos (local only) |
| `--prod` / `--ledger physical` | USB Ledger; quit Ledger Live first |

```sh
git clone git@github.com:grievouswounds/verycool.git
cd verycool

# Physical Ledger (Apple Silicon)
nix develop --accept-flake-config -c -- dev --prod

# Emulator (Linux Nix; Docker trampoline on macOS/Windows)
nix develop --accept-flake-config -c -- dev --dev
# or: nix develop --accept-flake-config -c dev-emulated
```

Windows: clone onto the **WSL ext4** filesystem (`~/verycool`), not `/mnt/c`. Then `nix develop` or `docker compose up --build` as documented below.

First physical run: unlocked Nano, **Ledger Sync / Ethereum / Security Key** installed, Ethereum **blind signing** on. Bootstrap talks to the device and writes `.data/keyring/*.enc`.

When healthy:

- API: `http://localhost:8787`
- Swagger: `http://localhost:8787/docs`
- Ready: `http://localhost:8787/health/ready`
- Facilitator: `http://localhost:8788`
- Speculos UI (emulated): host **15000** via Compose, or **5000** on native Linux `dev --dev`

```sh
# Apple Silicon emulator via Linux container
docker compose up --build
```

Give WSL/Docker enough RAM for the first Speculos + Ledger app compile. Persist `WALLET_PASS` if you use the container volume so the keyring stays decryptable.

Hot reload: `dev --prod` / `dev --dev`. No hot reload: `start --prod` / `start-emulated`. Same `--dev`/`--prod` flags apply to `ledger-bootstrap`, `e2e`, `mcp-check`, and `apps/mcp-bridge`.

### Tests

```sh
nix develop -c e2e                 # deterministic Speculos + Anvil suite
nix develop -c e2e-physical        # connected Ledger, tap the screens
aube run check                     # types, 100% type coverage, lint, policy, tests
```

Evidence lands in `reports/e2e/`. Speculos runs real app ELFs; it does not prove USB, firmware, or SE equivalence.

## Chain profiles

**Anvil 31337** — default `dev`/`start`. Manifest under `.data/` is verified (code hashes, Aqua bindings, matcher allowlists, fixture supply, seed orders) before the API serves.

**Sepolia 11155111** — live explorer demo. Deployer key must **not** be Anvil account 0. Pocket-style RPCs often reject Foundry fee APIs; broadcasts may use a second RPC that supports `eth_sendRawTransaction`. A physical Ledger keyring **cannot** decrypt a Speculos keyring; a coworker with a Nano must bootstrap locally and redeploy intent/matcher (operator is immutable).

## MCP bridge

Tools: `request_trade`, `post_trade`, `get_trades`, `cancel_trade`, `subscribe_to_user`, `unsubscribe_from_user`, `wipe_subscribed_trades`.

On first start the isolated signer runs `wallet-cli ring init` if needed, stores **ciphertext + address only**, and binds the agent after OAuth. Fund that address with gas and sell tokens; register the suggested Ledger delegation before the first live trade.

```sh
bun apps/mcp-bridge/src/main.ts --dev    # Speculos signer
bun apps/mcp-bridge/src/main.ts --prod   # physical Ledger
```

`AQUA_API_URL` defaults toward the local API (set it if not `http://127.0.0.1:8787` / `3000`). OAuth callback port defaults to `41739`.

## API surface (short)

Full schemas: `http://localhost:8787/docs` and `GET /v1/capabilities`.

| Area | Routes |
| --- | --- |
| Auth | `POST /v1/auth/challenges`, `/sessions`, `/refresh` |
| Trades | `POST /v1/trade-previews`, `POST`/`GET /v1/trades` (x402 exact Permit2) |
| Agent / policy | `POST /v1/agents/me/challenges`, `PUT /v1/agents/me`, delegations |
| Book / quotes | `POST /v1/trading`, `POST /v1/quotes/aqua` |
| Monitor | `/v1/erc20-monitor/*` (poller, not a websocket) |

Orders: market, limit, stop, trailing, take-profit, OCO, bracket. Policies: GTC, GTD, IOC, FOK, partial, AON, post-only, book-or-cancel. Amounts are canonical decimal strings; the deployment owns `CHAIN_ID`.

The API **never** takes a wallet key or broadcasts for the caller except through the isolated keeper/facilitator roles.

## Contracts

[`contracts/`](contracts/) — `AquaIntentController` (EIP-712 nonces, block+time triggers), `AquaOrderVault` / factory, `BoundedMatcher` (≤8 allowlisted target+selector calls). These are reference implementations, **not an audit**.

Arbitrary Aqua bytecode is out of scope: SwapVM instruction order is security-critical. Only the backend's limit grammar is projected into the public book.

## Hosted deploy

`aube run deploy` / `nix develop -c deploy` bundles API + facilitator to Vercel and can register a **draft** Bazantic gateway. Needs `baz login`, production manifest, Neon `DATABASE_URL`, env signer. Hardware AMR routes (`/v1/trades`, previews, delegations) stay on the **local MCP bridge**, not the hosted `{endpoint}/mcp` tool-caller.

## Deployments (Ethereum Sepolia)

Live demo on chain **11155111**. Explorer links go to Sepolia Etherscan.

We **reused** the vanity Aqua registry, canonical Permit2, x402 exact proxy, CREATE2 deployer, and Sepolia WETH. We **deployed** both SwapVM routers (the vanity router address was empty), fixture tokens, intent controller, vault factory, and bounded matcher. Intent `operator` is the Speculos keyring keeper from this machine — a physical Ledger needs a new keyring and a new operator deploy.

| What | Address | Notes |
| --- | --- | --- |
| Aqua registry | [`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`](https://sepolia.etherscan.io/address/0x1111113ccf1426a8e30e2bff5e005d929bf6a90a) | Existing 1inch vanity Aqua; routers bind `AQUA()` here |
| AquaSwapVMRouter | [`0x07b3475bbdb0389c21640b1334eff6a41970136b`](https://sepolia.etherscan.io/address/0x07b3475bbdb0389c21640b1334eff6a41970136b) | Market / SwapVM swap router we deployed |
| LimitSwapVMRouter | [`0xed9275955c0085a322c3b26735beb25cc21171f9`](https://sepolia.etherscan.io/address/0xed9275955c0085a322c3b26735beb25cc21171f9) | Limit opcode programs; not on the vanity address |
| WETH | [`0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`](https://sepolia.etherscan.io/address/0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14) | Canonical Sepolia wrapped ETH |
| Permit2 | [`0x000000000022D473030F116dDEE9F6B43aC78BA3`](https://sepolia.etherscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) | Canonical Uniswap Permit2 |
| x402 exact Permit2 proxy | [`0x402085c248EeA27D92E8b30b2C58ed07f9E20001`](https://sepolia.etherscan.io/address/0x402085c248EeA27D92E8b30b2C58ed07f9E20001) | Canonical x402 exact proxy (already on Sepolia) |
| AquaIntentController | [`0xbae91f21b2bf19013af494b107d9e0f8731c707a`](https://sepolia.etherscan.io/address/0xbae91f21b2bf19013af494b107d9e0f8731c707a) | EIP-712 nonces and stop/OCO triggers; operator = keeper |
| AquaOrderVaultFactory | [`0x90da9256755b496609dc0162a8cef413f8742d09`](https://sepolia.etherscan.io/address/0x90da9256755b496609dc0162a8cef413f8742d09) | Deploys per-order vaults |
| BoundedMatcher | [`0x1062b3da82e21b55be9d7658ed2557b9021ddc52`](https://sepolia.etherscan.io/address/0x1062b3da82e21b55be9d7658ed2557b9021ddc52) | Keeper may only `swap` / `activate` / `observe` / `execute` here |
| Fixture aUSD | [`0x019799b067422517212ce754f96d4faa6cc6a090`](https://sepolia.etherscan.io/address/0x019799b067422517212ce754f96d4faa6cc6a090) | Demo 6-decimal book token |
| Fixture aETH | [`0x0bB3844E65962A303BC4caBdD4B742a324f2f570`](https://sepolia.etherscan.io/address/0x0bB3844E65962A303BC4caBdD4B742a324f2f570) | Demo 18-decimal book token |
| Deployer | [`0x2337D66f63Ed5e6eFF25286f8034AcEFb8B5faC9`](https://sepolia.etherscan.io/address/0x2337D66f63Ed5e6eFF25286f8034AcEFb8B5faC9) | Funded EOA that broadcast the create txs |
| Agent (keyring) | [`0x5d6d277095483172fbf9313bff1b6a37f7e0d161`](https://sepolia.etherscan.io/address/0x5d6d277095483172fbf9313bff1b6a37f7e0d161) | MCP / LKRP agent; seeded with ETH + fixtures |
| Facilitator (keyring) | [`0x4b8011ee42d42ca5b9b5fea21072b03cf3913c1b`](https://sepolia.etherscan.io/address/0x4b8011ee42d42ca5b9b5fea21072b03cf3913c1b) | x402 facilitator signer |
| Keeper (keyring) | [`0xf7d88489a8df2be554eab383feeaf730bc525806`](https://sepolia.etherscan.io/address/0xf7d88489a8df2be554eab383feeaf730bc525806) | Intent operator and matcher operator |

## Next steps

- Physical-Ledger demo on Sepolia with the owner's device (new keyring → new operator contracts).
- Public HTTPS OpenAPI if we want a full Bazantic Agentify listing.
- Independent review of matcher allowlists and vault programs before any mainnet funds.

## Links

- [Repository](https://github.com/grievouswounds/verycool)
- Local Swagger: `http://localhost:8787/docs`
- [LANGSEC](docs/LANGSEC.md)
- Upstream: [1inch Aqua](https://github.com/1inch/aqua), [SwapVM](https://github.com/1inch/swap-vm), [x402](https://www.x402.org/), [Ledger wallet-cli](https://github.com/LedgerHQ)

## Team

Built as an ETHOnline project on this repo. See GitHub commit history for authors.

---

Speculos and Anvil are for development. Production custody is a real Ledger, `node-hid`, and released `wallet-cli`.
