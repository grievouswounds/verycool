import { describe, expect, test } from "bun:test";
import { addressSchema, hashSchema } from "@aqua/core";
import { ActivityCollector } from "../src/index.ts";
import type { ActionPage, ActivityChain, ActivityRepository, ActivitySubscription, TokenAction } from "../src/index.ts";

const owner = addressSchema.parse("0x1111111111111111111111111111111111111111");
const watched = addressSchema.parse("0x2222222222222222222222222222222222222222");
const peer = addressSchema.parse("0x3333333333333333333333333333333333333333");
const token = addressSchema.parse("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const transactionHash = hashSchema.parse(`0x${"11".repeat(32)}`);
const blockHash = hashSchema.parse(`0x${"22".repeat(32)}`);
const subscription: ActivitySubscription = { owner, watchedAddress: watched, active: true, nextBlock: 10n, createdAt: new Date(0), updatedAt: new Date(0) };

class MemoryRepository implements ActivityRepository {
  public stored: readonly TokenAction[] = [];
  public nextBlock = 0n;
  public async subscribe() { return { subscription, created: true }; }
  public async unsubscribe() { return true; }
  public async listSubscriptions() { return [subscription]; }
  public async listActiveSubscriptions() { return [subscription]; }
  public async storeBatch(_subscription: ActivitySubscription, actions: readonly TokenAction[], nextBlock: bigint) { this.stored = actions; this.nextBlock = nextBlock; }
  public async rewind() { return undefined; }
  public async listActions(): Promise<ActionPage> { return { items: [], hasMore: false }; }
  public async wipe() { return 0n; }
  public async acquireLease() { return true; }
}

class MemoryChain implements ActivityChain {
  public async safeHead() { return 12n; }
  public async firstBlockAtOrAfter() { return 10n; }
  public async transfers() { return [{ token, from: peer, to: watched, amount: 1_500_000n, transactionHash, logIndex: 1n, blockNumber: 11n, blockHash }]; }
  public async blockTimestamp() { return new Date("2026-09-07T12:00:00Z"); }
  public async blockHash() { return blockHash; }
  public async tokenMetadata() { return { decimals: 6, symbol: "TOK" }; }
}

describe("minute activity collector", () => {
  test("stores confirmed decimal actions before advancing the cursor", async () => {
    const repository = new MemoryRepository();
    await new ActivityCollector(repository, new MemoryChain(), { confirmations: 2n, blockChunkSize: 1000n, subscriptionBatchSize: 4 }).runOnce();
    expect(repository.stored[0]?.amount).toBe("1.5");
    expect(repository.stored[0]?.classification).toBe("received");
    expect(repository.nextBlock).toBe(13n);
  });
});
