import { describe, expect, test } from "bun:test";
import { tradingRequestSchema } from "../src/index.ts";

const pair = {
  baseToken: "0x1111111111111111111111111111111111111111",
  quoteToken: "0x2222222222222222222222222222222222222222",
} as const;

describe("agent-first trading input language", () => {
  test("recognizes a minimal resting limit order and applies explicit defaults", () => {
    const result = tradingRequestSchema.parse({
      action: "createOrder",
      order: {
        kind: "limit", pair, side: "sell",
        size: { denomination: "base", amount: "1.5" },
        limitPrice: "2500",
      },
    });
    expect(result.action).toBe("createOrder");
    if (result.action !== "createOrder" || result.order.kind !== "limit") throw new Error("wrong variant");
    expect(result.order.timeInForce).toEqual({ kind: "gtc" });
    expect(result.order.fillPolicy).toBe("partial");
    expect(result.order.postPolicy).toBe("normal");
  });

  test("recognizes compact public book and personal order queries", () => {
    expect(tradingRequestSchema.parse({ action: "query", query: { resource: "orderBook", pair } }).action).toBe("query");
    expect(tradingRequestSchema.parse({ action: "query", query: { resource: "orders", status: "open" } }).action).toBe("query");
  });

  test("rejects ambiguous policies, unknown fields, and JSON numbers", () => {
    expect(() => tradingRequestSchema.parse({
      action: "createOrder",
      order: { kind: "market", pair, side: "buy", size: { denomination: "quote", amount: 1000 }, limitPrice: "1" },
    })).toThrow();
    expect(() => tradingRequestSchema.parse({
      action: "createOrder",
      order: {
        kind: "limit", pair, side: "sell", size: { denomination: "base", amount: "1" }, limitPrice: "2",
        timeInForce: { kind: "fok" }, fillPolicy: "partial",
      },
    })).toThrow();
  });

  test("recognizes conditional, OCO, bracket, batch, cancellation, execution, and wrapping variants", () => {
    const conditional = {
      kind: "stopMarket", pair, side: "sell", size: { denomination: "base", amount: "1" },
      triggerPrice: "2000",
    } as const;
    const requests: readonly unknown[] = [
      { action: "createOrder", order: conditional },
      { action: "createOrder", order: { kind: "oco", pair, side: "sell", size: { denomination: "base", amount: "1" }, takeProfitPrice: "3000", stopLossPrice: "2000" } },
      { action: "createOrder", order: { kind: "bracket", pair, side: "buy", size: { denomination: "base", amount: "1" }, entry: { kind: "limit", limitPrice: "2400" }, takeProfitPrice: "3000", stopLossPrice: "2000" } },
      { action: "cancelOrders", selection: { scope: "selected", orderIds: ["eip155:1/0xabc"] } },
      { action: "executeOrder", orderId: "eip155:1/0xabc", size: { denomination: "base", amount: "1" } },
      { action: "batch", operations: [{ operation: "cancel", orderId: "eip155:1/0xabc" }] },
      { action: "manageWrappedNative", operation: "wrap", amount: "1.25" },
    ];
    for (const request of requests) expect(tradingRequestSchema.safeParse(request).success).toBe(true);
  });
});
