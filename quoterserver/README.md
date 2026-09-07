# 1inch Price Server

A small TypeScript/Express API server that returns crypto spot prices using
1inch's **Spot Price API** and **Token API**.

## Endpoints

### `GET /price/address/:chainId/:address`

Returns the spot price for a token given its contract address.

```
GET /price/address/1/0x111111111117dc0aa78b770fa6a738034120c302
```

```json
{
  "chainId": 1,
  "address": "0x111111111117dc0aa78b770fa6a738034120c302",
  "currency": "USD",
  "price": "0.2145"
}
```

### `GET /price/name/:chainId/:name`

Resolves a token name or symbol to an address (via the Token API's search
endpoint) and returns its spot price.

```
GET /price/name/1/1inch
```

```json
{
  "chainId": 1,
  "address": "0x111111111117dc0aa78b770fa6a738034120c302",
  "symbol": "1INCH",
  "name": "1inch",
  "currency": "USD",
  "price": "0.2145"
}
```

Both endpoints accept an optional `?currency=` query param (default `USD`,
set via `DEFAULT_CURRENCY` in `.env`). Any currency code supported by the
1inch Spot Price API's `/currencies` endpoint works.

Common chain IDs: Ethereum `1`, Polygon `137`, Arbitrum `42161`, BNB Chain
`56`, Optimism `10`, Base `8453`, Avalanche `43114`.

### `POST /aqua/quote`

Estimates an exact-input fill against one Aqua SwapVM order without sending a
transaction. The `taker` must be the EOA that would execute the actual swap:
some current Aqua strategies apply taker access controls during the quote.
`amountIn` and the returned amounts are base units.

```json
{
  "chainId": 1,
  "encodedOrder": "0x...",
  "tokenIn": "0x...",
  "tokenOut": "0x...",
  "amountIn": "1000000",
  "taker": "0x..."
}
```

This endpoint requires only `RPC_URL`. To find candidates, query Aqua's open
strategies API, then quote each executable order and compare `amountOut`.

### `POST /trade`

Submits an exact-input trade against an existing Aqua SwapVM maker order. It
simulates the call first, using `minAmountOut` as its on-chain slippage floor,
then broadcasts it from the wallet configured on the server. Amounts are token
base units, not human-readable decimals.

```json
{
  "chainId": 1,
  "encodedOrder": "0x...",
  "tokenIn": "0x...",
  "tokenOut": "0x...",
  "amountIn": "1000000",
  "minAmountOut": "300000000000000"
}
```

Set `RPC_URL` and `WALLET_PRIVATE_KEY` in `.env`. The configured wallet needs
the input-token balance and any required allowance for the Aqua SwapVM router.
Keep this endpoint behind authentication: it can sign and broadcast transactions.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your 1inch Business API key:

   ```bash
   cp .env.example .env
   ```

3. Run in dev mode (auto-reload):

   ```bash
   npm run dev
   ```

   Or build and run:

   ```bash
   npm run build
   npm start
   ```

The server listens on `PORT` (default `3000`).

## Notes

- Requires a 1inch Business API key (business.1inch.com), which requires
  KYC/KYB verification to obtain.
- The Spot Price API returns prices for a *contract address on a specific
  chain* — there's no "search by name" for prices directly, so the
  `/price/name` route first resolves the name via the Token API's
  `/token/v1.4/{chainId}/search` endpoint, then looks up the price for the
  resolved address. This means an ambiguous or misspelled name may resolve
  to a token you didn't intend — always sanity-check the `address`/`symbol`
  in the response.
- Errors from the upstream 1inch API (bad chain ID, unknown token, rate
  limits, auth failures) are passed through with their original HTTP status
  code where possible.
