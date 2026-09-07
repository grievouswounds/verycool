import axios, { AxiosInstance, isAxiosError } from "axios";
import { config } from "./config";
import { ApiError, SpotPriceResponse, TokenSearchResult } from "./types";

const client: AxiosInstance = axios.create({
  baseURL: config.oneInchBaseUrl,
  headers: {
    Authorization: `Bearer ${config.oneInchApiKey}`,
    accept: "application/json",
  },
  timeout: 10_000,
});

// Wraps axios errors from the 1inch API into our own ApiError, preserving
// the upstream status code and message where possible.
function toApiError(err: unknown, fallbackMessage: string): ApiError {
  if (isAxiosError(err)) {
    const status = err.response?.status ?? 502;
    const upstreamMessage =
      (err.response?.data as { message?: string; error?: string } | undefined)
        ?.message ??
      (err.response?.data as { message?: string; error?: string } | undefined)
        ?.error ??
      err.message;
    return new ApiError(status, `${fallbackMessage}: ${upstreamMessage}`);
  }
  return new ApiError(500, fallbackMessage);
}

/**
 * Fetches the spot price for a single token address on a given chain, in the
 * requested fiat currency, via the 1inch Spot Price API.
 *
 * Docs: https://business.1inch.com/portal/documentation/apis/spot-price/introduction
 */
export async function getSpotPriceByAddress(
  chainId: number,
  address: string,
  currency: string,
): Promise<string> {
  try {
    const { data } = await client.get<SpotPriceResponse>(
      `/price/v1.1/${chainId}/${address}`,
      { params: { currency } },
    );

    // Response is keyed by lowercase address.
    const key = Object.keys(data).find(
      (k) => k.toLowerCase() === address.toLowerCase(),
    );
    const price = key ? data[key] : undefined;

    if (!price) {
      throw new ApiError(
        404,
        `No price returned for address ${address} on chain ${chainId}`,
      );
    }
    return price;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw toApiError(err, "Failed to fetch spot price");
  }
}

/**
 * Resolves a token name/symbol to its best-matching token (address, symbol,
 * name, decimals) on a given chain, via the 1inch Token API's search endpoint.
 *
 * Docs: https://business.1inch.com/portal/documentation/apis/tokens/introduction
 */
export async function searchToken(
  chainId: number,
  query: string,
): Promise<TokenSearchResult> {
  try {
    const { data } = await client.get<TokenSearchResult[]>(
      `/token/v1.4/${chainId}/search`,
      { params: { query, limit: 1, ignore_listed: false } },
    );

    if (!Array.isArray(data) || data.length === 0) {
      throw new ApiError(
        404,
        `No token found matching "${query}" on chain ${chainId}`,
      );
    }
    return data[0];
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw toApiError(err, "Failed to search for token");
  }
}
