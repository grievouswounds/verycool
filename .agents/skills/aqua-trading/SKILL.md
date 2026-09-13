---
name: aqua-trading
description: >-
  Drive the Aqua Ledger Key Ring MCP trading server. Use when an agent needs to
  preview, fund, submit, list, cancel, or subscribe to Aqua trades on Sepolia
  through request_trade, post_trade, get_trades, cancel_trade, subscribe_to_user,
  unsubscribe_from_user, or wipe_subscribed_trades. Also use for the OAuth 2.1
  plus Ledger FIDO2 ceremony and the x402 Permit2 payment step.
---

# Aqua trading MCP

Aqua exposes seven MCP tools over a local stdio bridge (`bun apps/mcp-bridge/src/main.ts --prod`) and hosted Streamable HTTP `/mcp`.

## Tools

- `request_trade` — resolve, quote, simulate. Map language onto `policy.kind`: market, limit, stopMarket/stopLimit, takeProfitMarket/takeProfitLimit, trailingStop, oco, bracket.
- `post_trade` — sign the reviewed lifecycle, satisfy x402 exact Permit2 funding, submit. Reports a Clear Signing verdict when the owner Ledger signed.
- `get_trades` — own, subscribed, or combined records.
- `cancel_trade` — cancel resting or unwind armed orders.
- `subscribe_to_user` / `unsubscribe_from_user` / `wipe_subscribed_trades`.

## Auth

OAuth 2.1 with PKCE S256, RFC 7591 dynamic registration, RFC 9728 protected-resource metadata. Ledger FIDO2 (Security Key app) mints a PASETO `v4.public` with `amr: ["fido2","hwk"]`. Hardware is required on every trade route. Stdio Jam uses the bridge; do not point Jam at hosted `/mcp`.

## Payment

Trade activation is x402 exact Permit2 on the deployment chain, paid by the local LKRP agent. Hosted `/mcp` auto-pays when a delegated agent vault exists and otherwise returns JSON-RPC `-32042` with `PaymentRequired` under `_meta["x402/payment"]`.

## Sepolia addresses

aqua `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`, aquaSwapRouter `0x07b3475bbdb0389c21640b1334eff6a41970136b`, limitSwapRouter `0xed9275955c0085a322c3b26735beb25cc21171f9`, wrappedNativeToken `0xfff9976782d46cc05630d1f6ebab18b2324d6b14`, intentController `0xbae91f21b2bf19013af494b107d9e0f8731c707a`, orderVaultFactory `0x90da9256755b496609dc0162a8cef413f8742d09`, boundedMatcher `0x1062b3da82e21b55be9d7658ed2557b9021ddc52`, permit2 `0x000000000022d473030f116ddee9f6b43ac78ba3`, x402ExactPermit2Proxy `0x402085c248eea27d92e8b30b2c58ed07f9e20001`, tokenA `0x019799b067422517212ce754f96d4faa6cc6a090`, tokenB `0x0bb3844e65962a303bc4cabdd4b742a324f2f570`.
