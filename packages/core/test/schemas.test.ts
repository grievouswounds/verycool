import { describe, expect, test } from "bun:test";
import { directSwapRequestSchema, limitOrderRequestSchema } from "../src/index.ts";

const a = "0x1111111111111111111111111111111111111111";
const b = "0x2222222222222222222222222222222222222222";

describe("public request schemas", () => {
  test("accepts a canonical direct request", () => {
    expect(directSwapRequestSchema.safeParse({
      routerKind: "aquaAmm", encodedOrder: "0x00", tokenIn: a, tokenOut: b,
      amountIn: "1.25", slippageBps: 50,
      deadline: "2030-01-01T00:00:00Z", payWithNative: false, receiveNative: false,
    }).success).toBe(true);
  });

  test("requires exactly one swap amount and one deadline form", () => {
    const base = { encodedOrder: "0x00", tokenIn: a, tokenOut: b };
    expect(directSwapRequestSchema.safeParse({ ...base, amountIn: "1", amountOut: "2" }).success).toBe(false);
    expect(directSwapRequestSchema.safeParse({ ...base, amountIn: "1", deadline: "2030-01-01T00:00:00Z", lifetimeSeconds: 30 }).success).toBe(false);
  });

  test("rejects unknown fields and leading-zero amounts", () => {
    expect(limitOrderRequestSchema.safeParse({
      sellToken: a, buyToken: b, sellAmount: "01", buyAmount: "2",
      fillPolicy: "partial", expiresAt: "2030-01-01T00:00:00Z",
      salt: `0x${"00".repeat(32)}`, surprise: true,
    }).success).toBe(false);
  });
});
