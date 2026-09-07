// Spot Price API response shape: { [tokenAddressLowercase]: "price string" }
export type SpotPriceResponse = Record<string, string>;

// Shape of a single result from the Token API's /search endpoint.
// The API returns more fields than this; we only declare what we use.
export interface TokenSearchResult {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId?: number;
  logoURI?: string;
}

export interface PriceResult {
  chainId: number;
  address: string;
  symbol?: string;
  name?: string;
  currency: string;
  price: string;
}

/**
 * Amounts are integer base units (e.g. USDC's smallest unit), never decimal
 * display values. `encodedOrder` must be supplied by the Aqua order source.
 */
export interface TradeRequest {
  chainId: number;
  encodedOrder: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
}

export interface TradeResult {
  transactionHash: string;
  quotedAmountIn: string;
  quotedAmountOut: string;
  minAmountOut: string;
}

/** Read-only exact-input quote for one Aqua SwapVM strategy/order. */
export interface AquaQuoteRequest {
  chainId: number;
  encodedOrder: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  /** The EOA that would execute the swap; required for access-controlled strategies. */
  taker: string;
}

export interface AquaQuoteResult {
  amountIn: string;
  amountOut: string;
  tokenIn: string;
  tokenOut: string;
}

// Custom error carrying an HTTP status code, so route handlers can translate
// failures from the 1inch API (or our own validation) into sensible responses.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
