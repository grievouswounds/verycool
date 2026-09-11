import { AppError, calculateLimitAmounts, formatTokenAmount, parseTokenAmount, positiveAmountSchema } from "@aqua/core";
import type { Address, AuthenticatedPrincipal, TradingOrder, TradingRequest } from "@aqua/core";
import type { IntentAuthorizationService } from "./authorization.ts";
import type { BookLevel, IndexedFill, IndexedOrder, ProtocolGateway, TradingRepository } from "./types.ts";

export interface TradingHttpResult {
  readonly status: 200 | 202 | 402;
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Prepared plan is not an object");
  return Object.fromEntries(Object.entries(value));
};

export interface MatchingReport {
  readonly outcome: "fillsNow" | "rests" | "unfillable";
  readonly expectedFillPrice: string | null;
  readonly depthConsumedLevels: number;
  readonly depthConsumedBaseUnits: string;
  readonly unfilledRemainder: string | null;
  readonly fokFeasible: boolean | null;
}

const requiredBaseUnits = (order: TradingOrder, price: string, baseDecimals: number, quoteDecimals: number): bigint =>
  order.size.denomination === "base"
    ? parseTokenAmount(positiveAmountSchema.parse(order.size.amount), baseDecimals)
    : calculateLimitAmounts(order.side, order.size, price, baseDecimals, quoteDecimals).baseUnits;

const matchingFromBook = (
  order: TradingOrder, selected: readonly IndexedOrder[], remainingBase: bigint, requiredBase: bigint,
): MatchingReport => {
  const consumed = requiredBase < remainingBase ? requiredBase : remainingBase;
  const unfilled = requiredBase > remainingBase ? requiredBase - remainingBase : 0n;
  const tif = "timeInForce" in order ? order.timeInForce.kind : "ioc";
  const decimals = selected[0]?.baseDecimals ?? 0;
  return {
    outcome: consumed > 0n ? "fillsNow" : "unfillable",
    expectedFillPrice: selected[0]?.price ?? null,
    depthConsumedLevels: selected.filter((item) => BigInt(item.remainingBaseUnits) > 0n).length,
    depthConsumedBaseUnits: consumed.toString(),
    unfilledRemainder: tif === "ioc" ? formatTokenAmount(unfilled, decimals) : null,
    fokFeasible: tif === "fok" ? unfilled === 0n : null,
  };
};

const restingMatch = (limitPrice: string): MatchingReport => ({
  outcome: "rests", expectedFillPrice: limitPrice, depthConsumedLevels: 0, depthConsumedBaseUnits: "0",
  unfilledRemainder: null, fokFeasible: null,
});

const requirePrincipal = (principal: AuthenticatedPrincipal | null): AuthenticatedPrincipal => {
  if (principal === null) throw new AppError(401, "urn:aqua:error:authentication", "Bearer access token is required for this action");
  return principal;
};

const needsDelegation = (order: TradingOrder): boolean =>
  order.kind === "stopMarket" || order.kind === "stopLimit" || order.kind === "takeProfitMarket"
  || order.kind === "takeProfitLimit" || order.kind === "trailingStop" || order.kind === "oco" || order.kind === "bracket";

const priceParts = (value: string): readonly [bigint, bigint] => {
  const [whole = "", fraction = ""] = value.split(".");
  return [BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length)];
};

const comparePrices = (left: string, right: string): number => {
  const [ln, ld] = priceParts(left); const [rn, rd] = priceParts(right);
  const difference = ln * rd - rn * ld;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};

const invertPrice = (price: string): string => {
  const [numerator, denominator] = priceParts(price);
  if (numerator === 0n) return "0";
  const whole = denominator / numerator;
  const remainder = denominator % numerator;
  if (remainder === 0n) return whole.toString(10);
  const fraction = (remainder * 10n ** 36n / numerator).toString(10).padStart(36, "0").replace(/0+$/u, "");
  return `${whole.toString(10)}.${fraction}`;
};

/** Reorients indexed orders onto the requested pair so aUSD/aETH bids are visible when selling aETH. */
export const asRequestedPair = (orders: readonly IndexedOrder[], baseToken: Address, quoteToken: Address): readonly IndexedOrder[] => {
  if (orders.length === 0) return orders;
  if (orders.every((order) => order.baseToken === baseToken && order.quoteToken === quoteToken)) return orders;
  return orders.map((order) => {
    const quoteUnits = calculateLimitAmounts(
      order.side, { denomination: "base", amount: order.remainingBaseAmount }, order.price, order.baseDecimals, order.quoteDecimals,
    ).quoteUnits;
    const originalQuoteUnits = calculateLimitAmounts(
      order.side, { denomination: "base", amount: order.originalBaseAmount }, order.price, order.baseDecimals, order.quoteDecimals,
    ).quoteUnits;
    return {
      ...order, baseToken, quoteToken,
      side: order.side === "sell" ? "buy" as const : "sell" as const,
      price: invertPrice(order.price),
      originalBaseAmount: formatTokenAmount(originalQuoteUnits, order.quoteDecimals),
      remainingBaseAmount: formatTokenAmount(quoteUnits, order.quoteDecimals),
      originalBaseUnits: originalQuoteUnits.toString(10), remainingBaseUnits: quoteUnits.toString(10),
      baseDecimals: order.quoteDecimals, quoteDecimals: order.baseDecimals,
    };
  });
};

export const mergePairBooks = (
  direct: readonly IndexedOrder[],
  inverted: readonly IndexedOrder[],
  baseToken: Address,
  quoteToken: Address,
): readonly IndexedOrder[] => {
  const seen = new Set<string>();
  const merged: IndexedOrder[] = [];
  for (const order of [
    ...asRequestedPair(direct, baseToken, quoteToken),
    ...asRequestedPair(inverted, baseToken, quoteToken),
  ]) {
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    merged.push(order);
  }
  return merged;
};

const executableOrders = (orders: readonly IndexedOrder[], takerSide: "buy" | "sell", limitPrice: string | null = null): readonly IndexedOrder[] =>
  orders.filter((order) => order.side !== takerSide && (order.status === "open" || order.status === "partiallyFilled"))
    .filter((order) => limitPrice === null || (takerSide === "buy" ? comparePrices(order.price, limitPrice) <= 0 : comparePrices(order.price, limitPrice) >= 0))
    .sort((left, right) => {
      const price = takerSide === "buy" ? comparePrices(left.price, right.price) : comparePrices(right.price, left.price);
      return price !== 0 ? price : left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    })
    .slice(0, 8);

const aggregate = (orders: readonly IndexedOrder[], side: "buy" | "sell", depth: number): readonly BookLevel[] => {
  const levels = new Map<string, { base: bigint; count: bigint }>();
  for (const order of orders.filter((item) => item.side === side && (item.status === "open" || item.status === "partiallyFilled"))) {
    const current = levels.get(order.price) ?? { base: 0n, count: 0n };
    levels.set(order.price, { base: current.base + BigInt(order.remainingBaseUnits), count: current.count + 1n });
  }
  const decimals = orders[0]?.baseDecimals ?? 0;
  return Array.from(levels, ([price, value]) => ({ price, baseAmount: formatTokenAmount(value.base, decimals), orderCount: value.count.toString(10) }))
    .sort((left, right) => side === "buy" ? comparePrices(right.price, left.price) : comparePrices(left.price, right.price)).slice(0, depth);
};

const addDecimals = (values: readonly string[]): string => {
  const parts = values.map((value) => value.split("."));
  const scale = Math.max(0, ...parts.map((part) => part[1]?.length ?? 0));
  const total = parts.reduce((sum, part) => sum + BigInt(`${part[0] ?? "0"}${(part[1] ?? "").padEnd(scale, "0")}`), 0n);
  return formatTokenAmount(total, scale);
};

const candleSeconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 } as const;
const candles = (fills: readonly IndexedFill[], interval: keyof typeof candleSeconds) => {
  const buckets = new Map<number, IndexedFill[]>();
  for (const fill of fills) {
    const seconds = Math.floor(new Date(fill.occurredAt).getTime() / 1_000);
    const open = seconds - seconds % candleSeconds[interval];
    const bucket = buckets.get(open) ?? [];
    bucket.push(fill); buckets.set(open, bucket);
  }
  return Array.from(buckets.entries()).sort(([left], [right]) => left - right).map(([open, bucket]) => {
    const ordered = bucket.toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const prices = ordered.map((fill) => fill.price).toSorted(comparePrices);
    return {
      startsAt: new Date(open * 1_000).toISOString(), open: ordered[0]?.price, high: prices.at(-1), low: prices[0],
      close: ordered.at(-1)?.price, baseVolume: addDecimals(ordered.map((fill) => fill.baseAmount)),
      quoteVolume: addDecimals(ordered.map((fill) => fill.quoteAmount)), tradeCount: String(ordered.length),
    };
  });
};

export class TradingService {
  private readonly repository: TradingRepository;
  private readonly protocol: ProtocolGateway;
  private readonly authorization: IntentAuthorizationService;
  private readonly chainId: number;

  public constructor(
    repository: TradingRepository,
    protocol: ProtocolGateway,
    authorization: IntentAuthorizationService,
    chainId: number,
  ) { this.repository = repository; this.protocol = protocol; this.authorization = authorization; this.chainId = chainId; }

  public async execute(
    command: TradingRequest, principal: AuthenticatedPrincipal | null, authorizationHeader: string | null,
  ): Promise<TradingHttpResult> {
    if (command.action === "query") return this.query(command.query, principal);
    const actor = requirePrincipal(principal);
    if (!actor.scopes.has("trading:write")) {
      throw new AppError(403, "urn:aqua:error:scope", "Required scope: trading:write", { requiredScope: "trading:write" });
    }
    if (command.action === "manageWrappedNative") {
      return this.ok(command.action, await this.protocol.prepareWrappedNative(command.operation, command.amount, actor.address));
    }
    if (command.action === "prepareSwap") {
      return this.ok(command.action, await this.protocol.prepareSwap(command.swap, actor.address));
    }
    if (command.action === "createOrder") return this.create(command, actor, authorizationHeader);
    if (command.action === "executeOrder") {
      const selected = await this.ownedOrPublicOrder(command.orderId, null);
      const synthetic: TradingOrder = {
        kind: "market", pair: { baseToken: selected.baseToken, quoteToken: selected.quoteToken },
        side: selected.side === "buy" ? "sell" : "buy", size: command.size,
        timeInForce: { kind: "ioc" }, slippageBps: command.slippageBps,
      };
      return this.ok(command.action, await this.protocol.prepareMarketRoute(synthetic, [selected], actor.address));
    }
    if (command.action === "cancelOrders") {
      const orders = command.selection.scope === "selected"
        ? await Promise.all(command.selection.orderIds.map((id) => this.ownedOrPublicOrder(id, actor.address)))
        : (await this.repository.listOrders(actor.address, "open", 100)).items;
      return this.ok(command.action, {
        atomic: false, transactions: orders.map((order) => this.protocol.prepareCancellation(order, actor.address)),
        nextActions: ["signAndBroadcastTransactions"],
      });
    }
    if (command.action === "amendOrder") {
      const existing = await this.ownedOrPublicOrder(command.orderId, actor.address);
      const replacement = await this.protocol.prepareLimitFromTrading(command.replacement, actor.address);
      return this.ok(command.action, {
        atomic: false, orderedPlan: [this.protocol.prepareCancellation(existing, actor.address), replacement],
        nextActions: ["signDockThenShip"],
      });
    }
    return this.delegate(command, actor, authorizationHeader);
  }

  private async create(
    command: Extract<TradingRequest, { readonly action: "createOrder" }>,
    actor: AuthenticatedPrincipal,
    authorizationHeader: string | null,
  ): Promise<TradingHttpResult> {
    if (needsDelegation(command.order)) return this.delegate(command, actor, authorizationHeader);
    const orders = await this.pairBook(command.order.pair.baseToken, command.order.pair.quoteToken);
    if (command.order.kind === "market" || (command.order.kind === "limit" && (command.order.timeInForce.kind === "ioc" || command.order.timeInForce.kind === "fok"))) {
      return this.takeLiquidity(command, actor, orders);
    }
    if (command.order.kind === "limit" && command.order.postPolicy !== "normal") {
      if (executableOrders(orders, command.order.side, command.order.limitPrice).length > 0) {
        throw new AppError(409, "urn:aqua:error:crossing-post-policy", `${command.order.postPolicy} order would cross executable liquidity`);
      }
    }
    if (command.order.kind === "limit") {
      const selected = executableOrders(orders, command.order.side, command.order.limitPrice);
      const sample = selected[0] ?? orders[0];
      const baseDecimals = sample?.baseDecimals ?? 0; const quoteDecimals = sample?.quoteDecimals ?? 0;
      const required = requiredBaseUnits(command.order, command.order.limitPrice, baseDecimals, quoteDecimals);
      const depth = selected.reduce((sum, item) => sum + BigInt(item.remainingBaseUnits), 0n);
      if (command.order.postPolicy === "normal" && depth >= required && required > 0n && selected.length > 0) {
        return this.takeLiquidity(command, actor, orders);
      }
      const prepared = await this.protocol.prepareLimitFromTrading(command.order, actor.address);
      return this.ok(command.action, { ...asRecord(prepared), matching: restingMatch(command.order.limitPrice) });
    }
    return this.ok(command.action, await this.protocol.prepareLimitFromTrading(command.order, actor.address));
  }

  /** Always encode a shippable limit, even when the live book would fill it. Armed vault legs must not take liquidity now. */
  public async encodeRestingLimit(order: TradingOrder, actor: AuthenticatedPrincipal): Promise<TradingHttpResult> {
    if (order.kind !== "limit") throw new Error("Only plain limit orders can rest in a vault");
    const prepared = await this.protocol.prepareLimitFromTrading(order, actor.address);
    return this.ok("createOrder", { ...asRecord(prepared), matching: restingMatch(order.limitPrice) });
  }

  private async takeLiquidity(
    command: Extract<TradingRequest, { readonly action: "createOrder" }>,
    actor: AuthenticatedPrincipal,
    orders: readonly IndexedOrder[],
  ): Promise<TradingHttpResult> {
    const order = command.order;
    const limitPrice = order.kind === "limit" ? order.limitPrice : null;
    const selected = executableOrders(orders, order.side, limitPrice);
    if (selected.length === 0) throw new AppError(409, "urn:aqua:error:no-liquidity", "No compatible executable Aqua order is available");
    const baseDecimals = selected[0]?.baseDecimals ?? 0; const quoteDecimals = selected[0]?.quoteDecimals ?? 0;
    const price = order.kind === "limit" ? order.limitPrice : (selected[0]?.price ?? "0");
    const required = requiredBaseUnits(order, price, baseDecimals, quoteDecimals);
    const depth = selected.reduce((sum, item) => sum + BigInt(item.remainingBaseUnits), 0n);
    const tif = "timeInForce" in order ? order.timeInForce.kind : "ioc";
    if (tif === "fok" && depth < required) {
      throw new AppError(409, "urn:aqua:error:fok-unfillable", "FOK order does not have full-depth liquidity");
    }
    const prepared = await this.protocol.prepareMarketRoute(order, selected, actor.address);
    return this.ok(command.action, { ...asRecord(prepared), matching: matchingFromBook(order, selected, depth, required) });
  }

  private async delegate(command: TradingRequest, actor: AuthenticatedPrincipal, header: string | null): Promise<TradingHttpResult> {
    if (header === null) {
      const requirement = await this.authorization.challenge(command, actor.address);
      const encoded = Buffer.from(JSON.stringify(requirement), "utf8").toString("base64url");
      return {
        status: 402, body: { status: "authorizationRequired", requirement, nextActions: ["signTypedData", "retrySameCommand"] },
        headers: { "aqua-authorization-required": encoded },
      };
    }
    const intent = await this.authorization.authorize(command, actor.address, header);
    const receipt = Buffer.from(JSON.stringify({ profile: "aqua-intent-v1", authorizationId: intent.id, status: "active" }), "utf8").toString("base64url");
    return { status: 202, body: { status: "accepted", authorizationId: intent.id, nextActions: ["queryOrderStatus"] }, headers: { "aqua-authorization-response": receipt } };
  }

  private async query(query: Extract<TradingRequest, { readonly action: "query" }>["query"], principal: AuthenticatedPrincipal | null): Promise<TradingHttpResult> {
    if (query.resource === "order") return this.ok("query", { order: await this.ownedOrPublicOrder(query.orderId, null) });
    if (query.resource === "orderBook") {
      const orders = await this.pairBook(query.pair.baseToken, query.pair.quoteToken);
      const depth = Math.min(Number(query.depth), 100);
      return this.ok("query", { pair: query.pair, bids: aggregate(orders, "buy", depth), asks: aggregate(orders, "sell", depth) });
    }
    if (query.resource === "ticker" || query.resource === "recentTrades" || query.resource === "candles") {
      const limit = query.resource === "ticker" ? 2000 : Number(query.limit);
      const fills = await this.repository.listPairFills(query.pair.baseToken, query.pair.quoteToken, limit, "cursor" in query ? query.cursor : undefined);
      if (query.resource === "recentTrades") return this.ok("query", fills);
      if (query.resource === "candles") return this.ok("query", { items: candles(fills.items, query.interval), nextCursor: fills.nextCursor });
      const orders = await this.pairBook(query.pair.baseToken, query.pair.quoteToken);
      const bids = aggregate(orders, "buy", 1); const asks = aggregate(orders, "sell", 1);
      const recent = fills.items.filter((fill) => Date.now() - new Date(fill.occurredAt).getTime() <= 86_400_000);
      return this.ok("query", {
        pair: query.pair, lastPrice: recent[0]?.price ?? null, bestBid: bids[0]?.price ?? null, bestAsk: asks[0]?.price ?? null,
        baseVolume24h: addDecimals(recent.map((fill) => fill.baseAmount)), quoteVolume24h: addDecimals(recent.map((fill) => fill.quoteAmount)),
        tradeCount24h: String(recent.length),
      });
    }
    if (query.resource === "fees") return this.ok("query", { serviceFeeBps: "0", keeperFeeBps: "0", gasPaidBy: "operatorForDelegatedActions" });
    const actor = requirePrincipal(principal);
    if (!actor.scopes.has("trading:read")) {
      throw new AppError(403, "urn:aqua:error:scope", "Required scope: trading:read", { requiredScope: "trading:read" });
    }
    if (query.resource === "orders") return this.ok("query", await this.repository.listOrders(actor.address, query.status ?? null, Number(query.limit), query.cursor));
    if (query.resource === "fills") return this.ok("query", await this.repository.listFills(actor.address, query.orderId ?? null, Number(query.limit), query.cursor));
    const orders = (await this.repository.listOrders(actor.address, null, 100)).items;
    return this.ok("query", { balances: await this.protocol.queryBalances(query.tokens, actor.address, orders) });
  }

  private async pairBook(baseToken: Address, quoteToken: Address): Promise<readonly IndexedOrder[]> {
    const [direct, inverted] = await Promise.all([
      this.repository.listPairOrders(baseToken, quoteToken),
      this.repository.listPairOrders(quoteToken, baseToken),
    ]);
    return mergePairBooks(direct, inverted, baseToken, quoteToken);
  }

  private async ownedOrPublicOrder(id: string, owner: Address | null): Promise<IndexedOrder> {
    const order = await this.repository.getOrder(id);
    if (order === null) throw new AppError(404, "urn:aqua:error:order-not-found", "Order was not found");
    if (owner !== null && order.maker !== owner) throw new AppError(404, "urn:aqua:error:order-not-found", "Order was not found");
    return order;
  }

  private ok(action: string, result: unknown): TradingHttpResult {
    return { status: 200, body: { action, chainId: String(this.chainId), status: "ok", result, nextActions: [] } };
  }
}
