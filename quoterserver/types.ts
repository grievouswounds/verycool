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
