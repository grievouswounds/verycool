import { calculateLimitAmounts, hashSchema, parseTokenAmount, positiveAmountSchema } from "@aqua/core";
import type { Address, Hash, TradingOrder } from "@aqua/core";
import { encodeActivateTrigger, encodeObserveTrigger, hexToBytes, keccakHex } from "@aqua/evm";
import type { StoredIntent, TradingRepository } from "./types.ts";
import type { KeeperJob } from "./keeper.ts";

export interface TriggerObservation {
  readonly intentId: string; readonly proofHash: Hash; readonly firstBlock: bigint; readonly firstTimestamp: bigint;
}
export interface TriggerRepository {
  observation(intentId: string): Promise<TriggerObservation | null>;
  saveObservation(observation: TriggerObservation): Promise<void>;
  deleteObservation(intentId: string): Promise<void>;
  enqueue(job: KeeperJob): Promise<void>;
}
export interface TriggerConfiguration { readonly controller: Address; readonly minimumBlocks: bigint; readonly minimumSeconds: bigint }

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

export class TriggerEvaluator {
  private readonly trading: TradingRepository; private readonly triggers: TriggerRepository; private readonly config: TriggerConfiguration;
  public constructor(trading: TradingRepository, triggers: TriggerRepository, config: TriggerConfiguration) {
    this.trading = trading; this.triggers = triggers; this.config = config;
  }
  public async runOnce(blockNumber: bigint, timestamp: bigint): Promise<void> {
    for (const intent of await this.trading.listActiveIntents(1000)) await this.evaluate(intent, blockNumber, timestamp);
  }
  private async evaluate(intent: StoredIntent, blockNumber: bigint, timestamp: bigint): Promise<void> {
    const order = conditionalOrder(intent); const trigger = order === null ? null : triggerPrice(order);
    if (order === null || trigger === null) return;
    const book = await this.trading.listPairOrders(order.pair.baseToken, order.pair.quoteToken);
    const candidates = book.filter((candidate) => candidate.side !== order.side && (candidate.status === "open" || candidate.status === "partiallyFilled"))
      .sort((left, right) => order.side === "sell" ? compare(right.price, left.price) : compare(left.price, right.price)).slice(0, 8);
    const fullDepth = candidates.reduce((sum, candidate) => sum + BigInt(candidate.remainingBaseUnits), 0n);
    const baseDecimals = candidates[0]?.baseDecimals ?? 0; const quoteDecimals = candidates[0]?.quoteDecimals ?? 0;
    const requiredBase = order.size.denomination === "base"
      ? parseTokenAmount(positiveAmountSchema.parse(order.size.amount), baseDecimals)
      : calculateLimitAmounts(order.side, order.size, trigger.price, baseDecimals, quoteDecimals).baseUnits;
    const best = candidates[0]?.price;
    const condition = best !== undefined && fullDepth >= requiredBase
      && (trigger.comparison === "atMost" ? compare(best, trigger.price) <= 0 : compare(best, trigger.price) >= 0);
    const existing = await this.triggers.observation(intent.id);
    if (!condition) {
      if (existing !== null) {
        await this.triggers.enqueue(this.job(`${intent.id}:reset:${String(blockNumber)}`, encodeObserveTrigger(intent.commandHash, existing.proofHash, false)));
        await this.triggers.deleteObservation(intent.id);
      }
      return;
    }
    const proofHash = keccakHex(Uint8Array.from(candidates.flatMap((candidate) => Array.from(hexToBytes(candidate.orderHash)))));
    if (existing?.proofHash !== proofHash) {
      await this.triggers.saveObservation({ intentId: intent.id, proofHash, firstBlock: blockNumber, firstTimestamp: timestamp });
      await this.triggers.enqueue(this.job(`${intent.id}:observe:${proofHash}`, encodeObserveTrigger(intent.commandHash, proofHash, true)));
      return;
    }
    if (blockNumber >= existing.firstBlock + this.config.minimumBlocks && timestamp >= existing.firstTimestamp + this.config.minimumSeconds) {
      await this.triggers.enqueue(this.job(`${intent.id}:activate:${proofHash}`, encodeActivateTrigger(intent.commandHash, hashSchema.parse(intent.nonce), proofHash)));
    }
  }
  private job(id: string, data: KeeperJob["data"]): KeeperJob {
    return { id, target: this.config.controller, data, value: 0n, state: "ready", attempts: 0 };
  }
}
