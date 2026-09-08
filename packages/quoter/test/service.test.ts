import { describe, expect, test } from "bun:test";
import { addressSchema, hashSchema, positiveAmountSchema } from "@aqua/core";
import type { Address, DirectSwapRequest } from "@aqua/core";
import type { DirectQuoteResult } from "@aqua/contracts";
import { aquaQuoteRequestSchema, OneInchPriceClient, QuoterService } from "../src/index.ts";

const taker = addressSchema.parse("0x1111111111111111111111111111111111111111");
const tokenIn = addressSchema.parse("0x2222222222222222222222222222222222222222");
const tokenOut = addressSchema.parse("0x3333333333333333333333333333333333333333");
const orderHash = hashSchema.parse(`0x${"44".repeat(32)}`);
const rejected = async (promise: Promise<unknown>): Promise<unknown> => { try { await promise; return null; } catch (error: unknown) { return error; } };

class QuoteStub {
  public input: DirectSwapRequest | null = null;
  public taker: Address | null = null;
  public quoteDirect(input: DirectSwapRequest, actor: Address): Promise<DirectQuoteResult> {
    this.input = input; this.taker = actor;
    return Promise.resolve({ chainId: 1, orderHash, quote: { amountIn: positiveAmountSchema.parse("1"), amountOut: positiveAmountSchema.parse("2"), orderHash }, tokenDecimals: { tokenIn: 18, tokenOut: 6 } });
  }
}

describe("quoter service", () => {
  test("keeps prices optional without disabling Aqua quotes", async () => {
    const protocol = new QuoteStub();
    const service = new QuoterService({ chainId: 1, defaultCurrency: "USD", priceClient: null, protocol });
    expect(await rejected(service.priceByAddress(tokenIn, "USD"))).toMatchObject({ status: 503, type: "urn:aqua:error:price-unavailable" });
    const request = aquaQuoteRequestSchema.parse({ encodedOrder: "0x00", tokenIn, tokenOut, amountIn: "1" });
    expect(await service.quote(request, taker)).toMatchObject({ chainId: 1, quote: { amountOut: "2" } });
    expect(protocol.taker).toBe(taker);
    expect(protocol.input).toMatchObject({ amountIn: "1", slippageBps: 50, payWithNative: false, receiveNative: false });
  });

  test("resolves and normalizes a named token before fetching its price", async () => {
    let calls = 0;
    const priceClient = new OneInchPriceClient({ apiKey: "key", baseUrl: new URL("https://prices.example"), fetcher: () => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? Response.json([{ address: tokenIn.toUpperCase().replace("0X", "0x"), symbol: "TIN", name: "Token In", decimals: 18 }])
        : Response.json({ [tokenIn]: "3.25" }));
    } });
    const service = new QuoterService({ chainId: 8453, defaultCurrency: "USD", priceClient, protocol: new QuoteStub() });
    expect(await service.priceByName("tin", "EUR")).toEqual({ chainId: "8453", address: tokenIn, symbol: "TIN", name: "Token In", decimals: "18", currency: "EUR", price: "3.25" });
  });

  test("rejects ambiguous quote amount and timing alternatives", () => {
    expect(aquaQuoteRequestSchema.safeParse({ encodedOrder: "0x", tokenIn, tokenOut }).success).toBeFalse();
    expect(aquaQuoteRequestSchema.safeParse({ encodedOrder: "0x", tokenIn, tokenOut, amountIn: "1", amountOut: "2" }).success).toBeFalse();
    expect(aquaQuoteRequestSchema.safeParse({ encodedOrder: "0x", tokenIn, tokenOut, amountIn: "1", deadline: "2026-01-01T00:00:00Z", lifetimeSeconds: "300" }).success).toBeFalse();
  });
});
