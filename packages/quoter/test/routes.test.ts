import { describe, expect, test } from "bun:test";
import { addressSchema, AppError, hashSchema, positiveAmountSchema } from "@aqua/core";
import type { AuthenticationScope } from "@aqua/core";
import type { DirectQuoteResult } from "@aqua/contracts";
import { createQuoterRoutes, QuoterService } from "../src/index.ts";

const actor = addressSchema.parse("0x1111111111111111111111111111111111111111");
const tokenIn = addressSchema.parse("0x2222222222222222222222222222222222222222");
const tokenOut = addressSchema.parse("0x3333333333333333333333333333333333333333");
const orderHash = hashSchema.parse(`0x${"44".repeat(32)}`);

const protocol = { quoteDirect(): Promise<DirectQuoteResult> {
  return Promise.resolve({ chainId: 1, orderHash, quote: { amountIn: positiveAmountSchema.parse("1"), amountOut: positiveAmountSchema.parse("2"), orderHash }, tokenDecimals: { tokenIn: 18, tokenOut: 18 } });
} };

describe("Bun quoter routes", () => {
  test("requires trading:read and derives the quote taker from authentication", async () => {
    const scopes: AuthenticationScope[] = [];
    const quoter = new QuoterService({ chainId: 1, defaultCurrency: "USD", priceClient: null, protocol });
    const routes = createQuoterRoutes({ quoter, boundary: {
      execute: async (_request, action) => action(),
      parseJson: (request) => request.json(),
      authenticate: (_request, scope) => { scopes.push(scope); return Promise.resolve({ address: actor, sessionId: "test", scopes: new Set([scope]) }); },
    } });
    const response = await routes["/v1/quotes/aqua"].POST(new Request("http://localhost/v1/quotes/aqua", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ encodedOrder: "0x00", tokenIn, tokenOut, amountIn: "1" }),
    }));
    expect(response.status).toBe(200);
    expect(scopes).toEqual(["trading:read"]);
    expect(await response.json()).toMatchObject({ chainId: 1, quote: { amountOut: "2" } });
  });

  test("rejects duplicate and unknown price query parameters", async () => {
    const quoter = new QuoterService({ chainId: 1, defaultCurrency: "USD", priceClient: null, protocol });
    const routes = createQuoterRoutes({ quoter, boundary: {
      execute: async (_request, action) => { try { return await action(); } catch (error: unknown) { return Response.json({ status: error instanceof AppError ? error.status : 500 }); } },
      parseJson: (request) => request.json(),
      authenticate: () => Promise.resolve({ address: actor, sessionId: "test", scopes: new Set(["trading:read"]) }),
    } });
    const duplicate = Object.assign(new Request(`http://localhost/v1/prices/address/${tokenIn}?currency=USD&currency=EUR`), { params: { address: tokenIn } });
    const unknown = Object.assign(new Request(`http://localhost/v1/prices/address/${tokenIn}?fiat=USD`), { params: { address: tokenIn } });
    expect(await (await routes["/v1/prices/address/:address"].GET(duplicate)).json()).toEqual({ status: 422 });
    expect(await (await routes["/v1/prices/address/:address"].GET(unknown)).json()).toEqual({ status: 422 });
  });
});
