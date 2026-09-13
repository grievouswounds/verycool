import { describe, expect, test } from "bun:test";
import { addressSchema } from "@aqua/core";
import { OneInchPriceClient, QuoterService } from "../src/index.ts";

const tokenIn = addressSchema.parse("0x2222222222222222222222222222222222222222");
const rejected = async (promise: Promise<unknown>): Promise<unknown> => { try { await promise; return null; } catch (error: unknown) { return error; } };

describe("quoter service", () => {
  test("keeps prices optional", async () => {
    const service = new QuoterService({ chainId: 1, defaultCurrency: "USD", priceClient: null });
    expect(await rejected(service.priceByAddress(tokenIn, "USD"))).toMatchObject({ status: 503, type: "urn:aqua:error:price-unavailable" });
  });

  test("resolves and normalizes a named token before fetching its price", async () => {
    let calls = 0;
    const priceClient = new OneInchPriceClient({ apiKey: "key", baseUrl: new URL("https://prices.example"), fetcher: () => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? Response.json([{ address: tokenIn.toUpperCase().replace("0X", "0x"), symbol: "TIN", name: "Token In", decimals: 18 }])
        : Response.json({ [tokenIn]: "3.25" }));
    } });
    const service = new QuoterService({ chainId: 8453, defaultCurrency: "USD", priceClient });
    expect(await service.priceByName("tin", "EUR")).toEqual({ chainId: "8453", address: tokenIn, symbol: "TIN", name: "Token In", decimals: "18", currency: "EUR", price: "3.25" });
  });
});
