import { describe, expect, test } from "bun:test";
import { addressSchema, hashSchema, hexSchema } from "@aqua/core";
import { TriggerEvaluator } from "../src/index.ts";
import type { BookPage, ChainCheckpoint, IndexedFill, IndexedOrder, KeeperJob, StoredIntent, TradingRepository, TriggerObservation, TriggerRepository } from "../src/index.ts";
import type { ArmedTriggerLeg, TradeTriggerSource } from "../src/triggers.ts";

const maker = addressSchema.parse("0x1111111111111111111111111111111111111111");
const base = addressSchema.parse("0x2222222222222222222222222222222222222222");
const quote = addressSchema.parse("0x3333333333333333333333333333333333333333");
const controller = addressSchema.parse("0x4444444444444444444444444444444444444444");
const digest = hashSchema.parse(`0x${"55".repeat(32)}`);
const order: IndexedOrder = {
  id: "order", chainId: "eip155:1", maker, router: controller, orderHash: digest, encodedOrder: hexSchema.parse("0x00"),
  baseToken: base, quoteToken: quote, side: "buy", price: "99", originalBaseAmount: "1", remainingBaseAmount: "1",
  originalBaseUnits: "1000000000000000000", remainingBaseUnits: "1000000000000000000", baseDecimals: 18, quoteDecimals: 6,
  status: "open", blockNumber: "1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const intent: StoredIntent = {
  id: "intent", maker, commandHash: digest, nonce: hashSchema.parse(`0x${"66".repeat(32)}`), validBefore: new Date("2030-01-01T00:00:00Z"), status: "active",
  command: { action: "createOrder", order: { kind: "stopMarket", pair: { baseToken: base, quoteToken: quote }, side: "sell", size: { denomination: "base", amount: "1" }, triggerPrice: "100", timeInForce: { kind: "ioc" }, slippageBps: "50" } },
};
class Trading implements TradingRepository {
  public async getOrder() { return null; } public async getOrderByHash() { return null; }
  public async listOrders(): Promise<BookPage<IndexedOrder>> { return { items: [], nextCursor: null }; }
  public async listFills(): Promise<BookPage<IndexedFill>> { return { items: [], nextCursor: null }; }
  public async listPairFills(): Promise<BookPage<IndexedFill>> { return { items: [], nextCursor: null }; }
  public async listPairOrders() { return [order]; } public async saveRequirement() { return; } public async getRequirement() { return null; }
  public async listActiveIntents() { return [intent]; } public async consumeRequirement() { return null; }
  public async saveIndexedOrders() { return; } public async saveFills() { return; } public async checkpoint(): Promise<ChainCheckpoint | null> { return null; }
  public async commitProjection() { return; } public async rewindFromBlock() { return; }
}
class Triggers implements TriggerRepository {
  public current: TriggerObservation | null = null; public readonly jobs: KeeperJob[] = [];
  public async observation() { return this.current; } public async saveObservation(value: TriggerObservation) { this.current = value; }
  public async deleteObservation() { this.current = null; } public async enqueue(job: KeeperJob) { this.jobs.push(job); }
}

describe("persistent full-depth triggers", () => {
  test("queues observation and activation only after both block and time guarantees", async () => {
    const triggers = new Triggers(); const evaluator = new TriggerEvaluator(new Trading(), triggers, { controller, minimumBlocks: 2n, minimumSeconds: 30n });
    await evaluator.runOnce(10n, 100n); expect(triggers.jobs[0]?.data.slice(0, 10)).toBe("0xb1b0923a");
    await evaluator.runOnce(11n, 140n); expect(triggers.jobs).toHaveLength(1);
    await evaluator.runOnce(12n, 140n); expect(triggers.jobs[1]?.data.slice(0, 10)).toBe("0x5f330b0f");
  });

  test("enqueues a BoundedMatcher batch for an armed vault action", async () => {
    const matcher = addressSchema.parse("0x5555555555555555555555555555555555555555");
    const factory = addressSchema.parse("0x6666666666666666666666666666666666666666");
    const executeCall = hexSchema.parse(`0x95d5857e${"11".repeat(32)}`);
    const leg: ArmedTriggerLeg = {
      id: "leg", tradeId: "trade", intentHash: digest, groupNonce: hashSchema.parse(`0x${"77".repeat(32)}`),
      kind: "armed", role: "stop", pair: { baseToken: base, quoteToken: quote }, side: "sell",
      size: { denomination: "base", amount: "1" }, triggerPrice: "100", trail: null, activationPrice: null,
      highWater: null, executeCall, status: "armed",
    };
    class Armed implements TradeTriggerSource {
      public firing: string | null = null;
      public async listArmed() { return [leg]; }
      public async saveHighWater() { return; }
      public async markFiring(_id: string, jobId: string) { this.firing = jobId; }
    }
    class EmptyTrading extends Trading {
      public override async listActiveIntents() { return []; }
    }
    const triggers = new Triggers();
    const armed = new Armed();
    const evaluator = new TriggerEvaluator(new EmptyTrading(), triggers, {
      controller, matcher, factory, minimumBlocks: 1n, minimumSeconds: 1n,
    }, armed);
    await evaluator.runOnce(10n, 100n);
    await evaluator.runOnce(12n, 140n);
    expect(triggers.jobs.at(-1)?.target).toBe(matcher);
    expect(triggers.jobs.at(-1)?.data.slice(0, 10)).toBe("0xc8d18a45");
    expect(armed.firing).toBeString();
  });
});
