import { describe, expect, test } from "bun:test";
import { addressSchema, hashSchema, hexSchema } from "@aqua/core";
import type { AuthenticationScope } from "@aqua/core";
import type { RpcBlock, RpcLog } from "@aqua/core";
import { IntentAuthorizationService, TradingService, asRequestedPair, mergePairBooks } from "../src/index.ts";
import type { IndexedFill, IndexedOrder, ProtocolGateway, StoredIntent, TradingRepository } from "../src/index.ts";

const maker = addressSchema.parse("0x1111111111111111111111111111111111111111");
const base = addressSchema.parse("0x2222222222222222222222222222222222222222");
const quote = addressSchema.parse("0x3333333333333333333333333333333333333333");
const router = addressSchema.parse("0x4444444444444444444444444444444444444444");
const orderHash = hashSchema.parse(`0x${"11".repeat(32)}`);
const rejected = async (promise: Promise<unknown>): Promise<unknown> => { try { await promise; return null; } catch (error: unknown) { return error; } };

const indexedOrder = (side: "buy" | "sell", price: string, amount: string): IndexedOrder => ({
  id: `eip155:1/${side}/${price}`, chainId: "eip155:1", maker, router, orderHash,
  encodedOrder: hexSchema.parse("0x00"), baseToken: base, quoteToken: quote, side, price,
  originalBaseAmount: amount, remainingBaseAmount: amount, originalBaseUnits: amount, remainingBaseUnits: amount,
  baseDecimals: 0, quoteDecimals: 0, status: "open", blockNumber: "1",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

class MemoryRepository implements TradingRepository {
  public intents: StoredIntent[] = [];
  public readonly orders = [indexedOrder("buy", "9", "2"), indexedOrder("buy", "10", "3"), indexedOrder("sell", "12", "1")];
  public async getOrder(id: string) { return this.orders.find((order) => order.id === id) ?? null; }
  public async getOrderByHash() { return null; }
  public async listOrders() { return { items: this.orders, nextCursor: null }; }
  public async listFills() { return { items: [] as readonly IndexedFill[], nextCursor: null }; }
  public async listPairFills() { return { items: [] as readonly IndexedFill[], nextCursor: null }; }
  public async listPairOrders() { return this.orders; }
  public async saveRequirement(intent: StoredIntent) { this.intents.push(intent); }
  public async getRequirement(id: string) { return this.intents.find((intent) => intent.id === id) ?? null; }
  public async listActiveIntents() { return []; }
  public async consumeRequirement() { return null; }
  public async saveIndexedOrders() { return undefined; }
  public async saveFills() { return undefined; }
  public async checkpoint() { return null; }
  public async commitProjection() { return undefined; }
  public async rewindFromBlock() { return undefined; }
}

class ProtocolStub implements ProtocolGateway {
  public preparedSwaps = 0;
  public async prepareLimitFromTrading() { return { transaction: "ship" }; }
  public async prepareMarketRoute() { return { transaction: "swap" }; }
  public async prepareSwap() { this.preparedSwaps += 1; return { transaction: "prepared-swap" }; }
  public prepareCancellation() { return { transaction: "dock" }; }
  public async prepareWrappedNative() { return { transaction: "wrap" }; }
  public async queryBalances() { return []; }
}

class RpcStub {
  public async chainId() { return 1; }
  public async getCode() { return hexSchema.parse("0x"); }
  public async call() { return hexSchema.parse("0x"); }
  public async estimateGas() { return 1n; }
  public async tokenDecimals() { return 18; }
  public async tokenSymbol() { return null; }
  public async blockNumber() { return 1n; }
  public async block(): Promise<RpcBlock> { return { number: 1n, hash: orderHash, timestamp: 1n }; }
  public async logs(): Promise<readonly RpcLog[]> { return []; }
  public async transactionCount() { return 0n; }
  public async gasPrice() { return 1n; }
  public async maxPriorityFeePerGas() { return 1n; }
  public async sendRawTransaction() { return orderHash; }
  public async transactionReceipt() { return null; }
}

describe("unified trading service", () => {
  test("returns a sorted public book without requiring authentication", async () => {
    const repository = new MemoryRepository();
    const service = new TradingService(repository, new ProtocolStub(), new IntentAuthorizationService(repository, new RpcStub(), { chainId: 1, controller: router, validitySeconds: 300 }), 1);
    const result = await service.execute({ action: "query", query: { resource: "orderBook", pair: { baseToken: base, quoteToken: quote }, depth: "20" } }, null, null);
    const body = result.body["result"];
    expect(body).toEqual({ pair: { baseToken: base, quoteToken: quote }, bids: [{ price: "10", baseAmount: "3", orderCount: "1" }, { price: "9", baseAmount: "2", orderCount: "1" }], asks: [{ price: "12", baseAmount: "1", orderCount: "1" }] });
  });

  test("uses the aqua-intent-v1 402 challenge for conditional orders", async () => {
    const repository = new MemoryRepository();
    const service = new TradingService(repository, new ProtocolStub(), new IntentAuthorizationService(repository, new RpcStub(), { chainId: 1, controller: router, validitySeconds: 300 }), 1);
    const result = await service.execute({ action: "createOrder", order: { kind: "stopMarket", pair: { baseToken: base, quoteToken: quote }, side: "sell", size: { denomination: "base", amount: "1" }, triggerPrice: "8", timeInForce: { kind: "ioc" }, slippageBps: "50" } }, { address: maker, sessionId: "s", scopes: new Set(["trading:read", "trading:write"]) }, null);
    expect(result.status).toBe(402);
    expect(result.headers?.["aqua-authorization-required"]).toBeString();
    expect(repository.intents).toHaveLength(1);
  });

  test("requires trading:write and returns an unsigned prepared swap", async () => {
    const repository = new MemoryRepository();
    const protocol = new ProtocolStub();
    const service = new TradingService(repository, protocol, new IntentAuthorizationService(repository, new RpcStub(), { chainId: 1, controller: router, validitySeconds: 300 }), 1);
    const command = { action: "prepareSwap", swap: { routerKind: "aquaAmm", encodedOrder: hexSchema.parse("0x00"), tokenIn: base, tokenOut: quote, amountIn: "1", slippageBps: 50, payWithNative: false, receiveNative: false } } as const;
    expect(await rejected(service.execute(command, { address: maker, sessionId: "s", scopes: new Set(["trading:read"]) }, null))).toMatchObject({ status: 403 });
    const result = await service.execute(command, { address: maker, sessionId: "s", scopes: new Set(["trading:write"]) }, null);
    expect(result.body["result"]).toEqual({ transaction: "prepared-swap" });
    expect(protocol.preparedSwaps).toBe(1);
  });

  test("reorients an inverted pair so a sell can take the opposite book", () => {
    const inverted = asRequestedPair([indexedOrder("sell", "0.001", "1000")], quote, base);
    expect(inverted[0]?.side).toBe("buy");
    expect(inverted[0]?.baseToken).toBe(quote);
  });

  test("merges inverted-pair depth onto the requested pair without duplicating ids", () => {
    const canonical = indexedOrder("sell", "0.001", "1000");
    const other = {
      ...indexedOrder("sell", "0.002", "500"), id: "other",
      orderHash: hashSchema.parse(`0x${"22".repeat(32)}`), baseToken: quote, quoteToken: base,
    };
    const merged = mergePairBooks([canonical], [other], base, quote);
    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.side).sort()).toEqual(["buy", "sell"]);
    expect(mergePairBooks([canonical], [canonical], base, quote)).toHaveLength(1);
  });

  test("encodes a resting limit even when the live book would fill it", async () => {
    const repository = new MemoryRepository();
    const protocol = new ProtocolStub();
    const service = new TradingService(repository, protocol, new IntentAuthorizationService(repository, new RpcStub(), { chainId: 1, controller: router, validitySeconds: 300 }), 1);
    const actor = { address: maker, sessionId: "s", scopes: new Set<AuthenticationScope>(["trading:read", "trading:write"]) };
    const order = {
      kind: "limit" as const, pair: { baseToken: base, quoteToken: quote }, side: "sell" as const,
      size: { denomination: "base" as const, amount: "1" }, limitPrice: "9", timeInForce: { kind: "gtc" as const },
      fillPolicy: "partial" as const, postPolicy: "normal" as const,
    };
    const crossing = await service.execute({ action: "createOrder", order }, actor, null);
    expect(crossing.body["result"]).toMatchObject({ transaction: "swap" });
    const resting = await service.encodeRestingLimit(order, actor);
    expect(resting.body["result"]).toMatchObject({ transaction: "ship", matching: { outcome: "rests" } });
  });

  test("rejects FOK when the book cannot fill the full size", async () => {
    const repository = new MemoryRepository();
    const service = new TradingService(repository, new ProtocolStub(), new IntentAuthorizationService(repository, new RpcStub(), { chainId: 1, controller: router, validitySeconds: 300 }), 1);
    expect(await rejected(service.execute({
      action: "createOrder",
      order: {
        kind: "market", pair: { baseToken: base, quoteToken: quote }, side: "sell",
        size: { denomination: "base", amount: "1000000" }, timeInForce: { kind: "fok" }, slippageBps: "50",
      },
    }, { address: maker, sessionId: "s", scopes: new Set(["trading:read", "trading:write"]) }, null))).toMatchObject({ status: 409 });
  });
});
