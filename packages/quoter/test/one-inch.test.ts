import { describe, expect, test } from "bun:test";
import { addressSchema } from "@aqua/core";
import { OneInchPriceClient } from "../src/index.ts";

const token = addressSchema.parse("0x1111111111111111111111111111111111111111");
const rejected = async (promise: Promise<unknown>): Promise<unknown> => { try { await promise; return null; } catch (error: unknown) { return error; } };

describe("1inch price client", () => {
  test("uses the configured chain, currency, and bearer credential", async () => {
    let requestUrl = "";
    let authorization = "";
    const client = new OneInchPriceClient({ apiKey: "secret", baseUrl: new URL("https://prices.example"), fetcher: (input, init) => {
      requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(Response.json({ [token]: "12.50" }));
    } });
    expect(await client.price(8453, token, "USD")).toBe("12.50");
    expect(requestUrl).toBe(`https://prices.example/price/v1.1/8453/${token}?currency=USD`);
    expect(authorization).toBe("Bearer secret");
  });

  test("recognizes one bounded token search result", async () => {
    const client = new OneInchPriceClient({ apiKey: "secret", baseUrl: new URL("https://prices.example"), fetcher: () => Promise.resolve(Response.json([
      { address: token, symbol: "TOK", name: "Token", decimals: 18, ignored: true },
    ])) });
    expect(await client.search(1, "tok")).toMatchObject({ address: token, symbol: "TOK", name: "Token", decimals: 18 });
  });

  test("rejects malformed and oversized upstream responses", async () => {
    const malformed = new OneInchPriceClient({ apiKey: "secret", baseUrl: new URL("https://prices.example"), fetcher: () => Promise.resolve(new Response("not-json")) });
    expect(await rejected(malformed.price(1, token, "USD"))).toMatchObject({ status: 502 });
    const oversized = new OneInchPriceClient({ apiKey: "secret", baseUrl: new URL("https://prices.example"), maximumResponseBytes: 8, fetcher: () => Promise.resolve(new Response("123456789")) });
    expect(await rejected(oversized.price(1, token, "USD"))).toMatchObject({ status: 502 });
  });

  test("maps rate limits and transport failures to stable application errors", async () => {
    const limited = new OneInchPriceClient({ apiKey: "secret", baseUrl: new URL("https://prices.example"), fetcher: () => Promise.resolve(new Response(null, { status: 429 })) });
    expect(await rejected(limited.price(1, token, "USD"))).toMatchObject({ status: 429, type: "urn:aqua:error:price-upstream" });
    const failed = new OneInchPriceClient({ apiKey: "secret", baseUrl: new URL("https://prices.example"), fetcher: () => Promise.reject(new Error("offline")) });
    expect(await rejected(failed.price(1, token, "USD"))).toMatchObject({ status: 502, type: "urn:aqua:error:price-upstream" });
  });
});
