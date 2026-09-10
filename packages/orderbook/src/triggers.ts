import { calculateLimitAmounts, hashSchema, hexSchema, parseTokenAmount, positiveAmountSchema } from "@aqua/core";
import type { Address, Hash, Hex, TradingOrder } from "@aqua/core";
import { encodeActivateTrigger, encodeBoundedMatcherExecute, encodeObserveTrigger, hexToBytes, keccakHex } from "@aqua/evm";
import type { StoredIntent, TradingRepository } from "./types.ts";
import type { KeeperJob } from "./keeper.ts";
import { mergePairBooks } from "./service.ts";

export interface TriggerObservation {
  readonly intentId: string; readonly proofHash: Hash; readonly firstBlock: bigint; readonly firstTimestamp: bigint;
}
export interface ArmedTriggerLeg {
  readonly id: string;
  readonly tradeId: string;
  readonly intentHash: Hash;
  readonly groupNonce: Hash;
  readonly kind: string;
  readonly role: string;
  readonly pair: { readonly baseToken: Address; readonly quoteToken: Address };
  readonly side: "buy" | "sell";
  readonly size: { readonly denomination: "base" | "quote"; readonly amount: string };
  readonly triggerPrice: string | null;
  readonly trail: { readonly unit: "bps" | "quote"; readonly value: string } | null;
  readonly activationPrice: string | null;
  readonly highWater: string | null;
  readonly executeCall: Hex;
  readonly status: "armed" | "firing" | "executed" | "cancelled" | "closed";
}
export interface TriggerRepository {
  observation(intentId: string): Promise<TriggerObservation | null>;
  saveObservation(observation: TriggerObservation): Promise<void>;
  deleteObservation(intentId: string): Promise<void>;
  enqueue(job: KeeperJob): Promise<void>;
  highWater?(intentId: string): Promise<string | null>;
  saveHighWater?(intentId: string, price: string): Promise<void>;
}
export interface TradeTriggerSource {
  listArmed(): Promise<readonly ArmedTriggerLeg[]>;
  saveHighWater(id: string, price: string): Promise<void>;
  markFiring(id: string, jobId: string): Promise<void>;
}
export interface TriggerConfiguration {
  readonly controller: Address;
  readonly matcher?: Address;
  readonly factory?: Address;
  readonly minimumBlocks: bigint;
  readonly minimumSeconds: bigint;
}

const conditionalOrder = (intent: StoredIntent): TradingOrder | null => {
  const command = intent.command;
  if (command.action === "createOrder") return command.order;
  if (command.action === "amendOrder") return command.replacement;
  return null;
};
const triggerPrice = (order: TradingOrder): { readonly price: string; readonly comparison: "atMost" | "atLeast" } | null => {
  if (order.kind === "stopMarket" || order.kind === "stopLimit") return { price: order.triggerPrice, comparison: order.side === "sell" ? "atMost" : "atLeast" };
  if (order.kind === "takeProfitMarket" || order.kind === "takeProfitLimit") return { price: order.triggerPrice, comparison: order.side === "sell" ? "atLeast" : "atMost" };
  return null;
};
const parts = (value: string): readonly [bigint, bigint] => {
  const [whole = "0", fraction = ""] = value.split("."); return [BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length)];
};
const compare = (left: string, right: string): number => {
  const [ln, ld] = parts(left); const [rn, rd] = parts(right); const delta = ln * rd - rn * ld;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
};
const subtractPrice = (left: string, right: string): string => {
  const [ln, ld] = parts(left); const [rn, rd] = parts(right);
  const scale = ld > rd ? ld : rd;
  const value = ln * (scale / ld) - rn * (scale / rd);
  if (value <= 0n) return "0";
  const digits = scale.toString().length - 1;
  const raw = value.toString().padStart(digits + 1, "0");
  if (digits === 0) return raw;
  const whole = raw.slice(0, raw.length - digits); const fraction = raw.slice(raw.length - digits).replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
};
const applyBps = (price: string, bps: string): string => {
  const [n, d] = parts(price);
  const reduced = n * (10_000n - BigInt(bps));
  const denom = d * 10_000n;
  const whole = reduced / denom; const rest = reduced % denom;
  if (rest === 0n) return whole.toString();
  const fraction = rest.toString().padStart(denom.toString().length - 1, "0").replace(/0+$/u, "");
  return `${whole.toString()}.${fraction}`;
};
const trailTrigger = (highWater: string, trail: { readonly unit: "bps" | "quote"; readonly value: string }): string =>
  trail.unit === "bps" ? applyBps(priceNormalize(highWater), trail.value) : subtractPrice(highWater, trail.value);
const priceNormalize = (value: string): string => value;

export class TriggerEvaluator {
  private readonly trading: TradingRepository; private readonly triggers: TriggerRepository;
  private readonly config: TriggerConfiguration; private readonly armed: TradeTriggerSource | null;
  public constructor(
    trading: TradingRepository, triggers: TriggerRepository, config: TriggerConfiguration, armed: TradeTriggerSource | null = null,
  ) {
    this.trading = trading; this.triggers = triggers; this.config = config; this.armed = armed;
  }
  public async runOnce(blockNumber: bigint, timestamp: bigint): Promise<void> {
    for (const intent of await this.trading.listActiveIntents(1000)) await this.evaluateIntent(intent, blockNumber, timestamp);
    if (this.armed !== null) {
      for (const leg of await this.armed.listArmed()) await this.evaluateArmed(leg, blockNumber, timestamp);
    }
  }
  private async evaluateIntent(intent: StoredIntent, blockNumber: bigint, timestamp: bigint): Promise<void> {
    const order = conditionalOrder(intent);
    if (order === null) return;
    if (order.kind === "oco") {
      await this.evaluateCondition(intent.id, intent.commandHash, hashSchema.parse(intent.nonce), order, {
        price: order.stopLossPrice, comparison: order.side === "sell" ? "atMost" : "atLeast",
      }, blockNumber, timestamp);
      await this.evaluateCondition(`${intent.id}:tp`, intent.commandHash, hashSchema.parse(intent.nonce), order, {
        price: order.takeProfitPrice, comparison: order.side === "sell" ? "atLeast" : "atMost",
      }, blockNumber, timestamp);
      return;
    }
    if (order.kind === "bracket") {
      await this.evaluateCondition(`${intent.id}:sl`, intent.commandHash, hashSchema.parse(intent.nonce), order, {
        price: order.stopLossPrice, comparison: order.side === "sell" ? "atMost" : "atLeast",
      }, blockNumber, timestamp);
      await this.evaluateCondition(`${intent.id}:tp`, intent.commandHash, hashSchema.parse(intent.nonce), order, {
        price: order.takeProfitPrice, comparison: order.side === "sell" ? "atLeast" : "atMost",
      }, blockNumber, timestamp);
      return;
    }
    if (order.kind === "trailingStop") {
      const highWater = await this.trackHighWater(intent.id, order);
      if (highWater === null) return;
      await this.evaluateCondition(intent.id, intent.commandHash, hashSchema.parse(intent.nonce), order, {
        price: trailTrigger(highWater, order.trail), comparison: order.side === "sell" ? "atMost" : "atLeast",
      }, blockNumber, timestamp);
      return;
    }
    const trigger = triggerPrice(order);
    if (trigger === null) return;
    await this.evaluateCondition(intent.id, intent.commandHash, hashSchema.parse(intent.nonce), order, trigger, blockNumber, timestamp);
  }
  private async evaluateArmed(leg: ArmedTriggerLeg, blockNumber: bigint, timestamp: bigint): Promise<void> {
    if (leg.status !== "armed") return;
    const synthetic: TradingOrder = {
      kind: "stopMarket", pair: leg.pair, side: leg.side, size: leg.size, triggerPrice: leg.triggerPrice ?? "0",
      timeInForce: { kind: "ioc" }, slippageBps: "50",
    };
    let trigger: { readonly price: string; readonly comparison: "atMost" | "atLeast" } | null =
      leg.triggerPrice === null ? null : { price: leg.triggerPrice, comparison: this.comparisonFor(leg) };
    if (leg.trail !== null) {
      const highWater = await this.trackArmedHighWater(leg);
      if (highWater === null) return;
      trigger = { price: trailTrigger(highWater, leg.trail), comparison: leg.side === "sell" ? "atMost" : "atLeast" };
    }
    if (trigger === null) return;
    await this.evaluateCondition(leg.id, leg.intentHash, leg.groupNonce, synthetic, trigger, blockNumber, timestamp, leg);
  }
  private comparisonFor(leg: ArmedTriggerLeg): "atMost" | "atLeast" {
    if (leg.role === "takeProfit") return leg.side === "sell" ? "atLeast" : "atMost";
    return leg.side === "sell" ? "atMost" : "atLeast";
  }
  private async trackHighWater(intentId: string, order: Extract<TradingOrder, { readonly kind: "trailingStop" }>): Promise<string | null> {
    const book = await this.book(order.pair.baseToken, order.pair.quoteToken);
    const best = this.bestPrice(book, order.side);
    if (best === undefined) return null;
    const previous = this.triggers.highWater === undefined ? null : await this.triggers.highWater(intentId);
    if (order.activationPrice !== undefined && previous === null && compare(best, order.activationPrice) < 0) return null;
    const next = previous === null || compare(best, previous) > 0 ? best : previous;
    if (this.triggers.saveHighWater !== undefined && next !== previous) await this.triggers.saveHighWater(intentId, next);
    return next;
  }
  private async trackArmedHighWater(leg: ArmedTriggerLeg): Promise<string | null> {
    if (this.armed === null) return null;
    const book = await this.book(leg.pair.baseToken, leg.pair.quoteToken);
    const best = this.bestPrice(book, leg.side);
    if (best === undefined) return null;
    if (leg.activationPrice !== null && leg.highWater === null && compare(best, leg.activationPrice) < 0) return null;
    const previous = leg.highWater;
    const next = previous === null || compare(best, previous) > 0 ? best : previous;
    if (next !== previous) await this.armed.saveHighWater(leg.id, next);
    return next;
  }
  private async book(baseToken: Address, quoteToken: Address) {
    const [direct, inverted] = await Promise.all([
      this.trading.listPairOrders(baseToken, quoteToken),
      this.trading.listPairOrders(quoteToken, baseToken),
    ]);
    return mergePairBooks(direct, inverted, baseToken, quoteToken);
  }
  private bestPrice(book: Awaited<ReturnType<TradingRepository["listPairOrders"]>>, side: "buy" | "sell"): string | undefined {
    const candidates = book.filter((candidate) => candidate.side !== side && (candidate.status === "open" || candidate.status === "partiallyFilled"))
      .sort((left, right) => side === "sell" ? compare(right.price, left.price) : compare(left.price, right.price));
    return candidates[0]?.price;
  }
  private async evaluateCondition(
    observationId: string, intentHash: Hash, group: Hash, order: TradingOrder,
    trigger: { readonly price: string; readonly comparison: "atMost" | "atLeast" },
    blockNumber: bigint, timestamp: bigint, armed: ArmedTriggerLeg | null = null,
  ): Promise<void> {
    const book = await this.book(order.pair.baseToken, order.pair.quoteToken);
    const candidates = book.filter((candidate) => candidate.side !== order.side && (candidate.status === "open" || candidate.status === "partiallyFilled"))
      .sort((left, right) => order.side === "sell" ? compare(right.price, left.price) : compare(left.price, right.price)).slice(0, 8);
    const fullDepth = candidates.reduce((sum, candidate) => sum + BigInt(candidate.remainingBaseUnits), 0n);
    const baseDecimals = candidates[0]?.baseDecimals ?? 0; const quoteDecimals = candidates[0]?.quoteDecimals ?? 0;
    const requiredBase = order.size.denomination === "base"
      ? parseTokenAmount(positiveAmountSchema.parse(order.size.amount), baseDecimals)
      : calculateLimitAmounts(order.side, order.size, trigger.price, baseDecimals, quoteDecimals).baseUnits;
    const best = candidates[0]?.price;
    const depthOk = armed !== null || fullDepth >= requiredBase;
    const condition = best !== undefined && depthOk
      && (trigger.comparison === "atMost" ? compare(best, trigger.price) <= 0 : compare(best, trigger.price) >= 0);
    const existing = await this.triggers.observation(observationId);
    if (!condition) {
      if (existing !== null) {
        await this.triggers.enqueue(this.controllerJob(`${observationId}:reset:${String(blockNumber)}`, encodeObserveTrigger(intentHash, existing.proofHash, false)));
        await this.triggers.deleteObservation(observationId);
      }
      return;
    }
    const proofHash = keccakHex(Uint8Array.from(candidates.flatMap((candidate) => Array.from(hexToBytes(candidate.orderHash)))));
    if (existing?.proofHash !== proofHash) {
      await this.triggers.saveObservation({ intentId: observationId, proofHash, firstBlock: blockNumber, firstTimestamp: timestamp });
      await this.triggers.enqueue(this.controllerJob(`${observationId}:observe:${proofHash}`, encodeObserveTrigger(intentHash, proofHash, true)));
      return;
    }
    if (blockNumber >= existing.firstBlock + this.config.minimumBlocks && timestamp >= existing.firstTimestamp + this.config.minimumSeconds) {
      if (armed !== null && this.config.matcher !== undefined && this.config.factory !== undefined) {
        const activate = encodeActivateTrigger(intentHash, group, proofHash);
        const jobId = `${observationId}:fire:${proofHash}`;
        await this.triggers.enqueue(this.matcherJob(jobId, encodeBoundedMatcherExecute(
          [this.config.controller, this.config.factory], [activate, hexSchema.parse(armed.executeCall)],
        )));
        if (this.armed !== null) await this.armed.markFiring(armed.id, jobId);
        return;
      }
      await this.triggers.enqueue(this.controllerJob(`${observationId}:activate:${proofHash}`, encodeActivateTrigger(intentHash, group, proofHash)));
    }
  }
  private controllerJob(id: string, data: KeeperJob["data"]): KeeperJob {
    return { id, target: this.config.controller, data, value: 0n, state: "ready", attempts: 0 };
  }
  private matcherJob(id: string, data: KeeperJob["data"]): KeeperJob {
    const matcher = this.config.matcher;
    if (matcher === undefined) throw new Error("Bounded matcher is required for armed trigger execution");
    return { id, target: matcher, data, value: 0n, state: "ready", attempts: 0 };
  }
}
