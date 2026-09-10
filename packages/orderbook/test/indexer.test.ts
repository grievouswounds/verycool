import { describe, expect, test } from "bun:test";
import { Abi } from "@hazae41/cubane";
import { addressSchema, hashSchema, hexSchema } from "@aqua/core";
import type { Address, Hash, RpcBlock, RpcLog } from "@aqua/core";
import { AQUA_EVENT_TOPICS, buildLimitProgram } from "@aqua/contracts";
import { addressToBigInt, encodeOrder, hexToBytes } from "@aqua/evm";
import { OrderBookIndexer } from "../src/index.ts";
import type { BookPage, ChainCheckpoint, IndexedFill, IndexedOrder, ProtocolProjection, TradingRepository } from "../src/index.ts";

const maker = addressSchema.parse("0x1111111111111111111111111111111111111111");
const router = addressSchema.parse("0x2222222222222222222222222222222222222222");
const aqua = addressSchema.parse("0x3333333333333333333333333333333333333333");
const base = addressSchema.parse("0x4444444444444444444444444444444444444444");
const quote = addressSchema.parse("0x5555555555555555555555555555555555555555");
const blockHash = hashSchema.parse(`0x${"66".repeat(32)}`); const transactionHash = hashSchema.parse(`0x${"77".repeat(32)}`);
const salt = hashSchema.parse(`0x${"88".repeat(32)}`);

class Repository implements TradingRepository {
  public current: ChainCheckpoint | null = null; public projection: ProtocolProjection | null = null; public rewound = false;
  public async getOrder() { return null; } public async getOrderByHash() { return null; }
  public async listOrders(): Promise<BookPage<IndexedOrder>> { return { items: [], nextCursor: null }; }
  public async listFills(): Promise<BookPage<IndexedFill>> { return { items: [], nextCursor: null }; }
  public async listPairFills(): Promise<BookPage<IndexedFill>> { return { items: [], nextCursor: null }; }
  public async listPairOrders() { return []; } public async saveRequirement() { return; }
  public async getRequirement() { return null; } public async consumeRequirement() { return null; }
  public async listActiveIntents() { return []; }
  public async saveIndexedOrders() { return; } public async saveFills() { return; }
  public async checkpoint() { return this.current; }
  public async commitProjection(projection: ProtocolProjection, checkpoint: ChainCheckpoint) { this.projection = projection; this.current = checkpoint; }
  public async rewindFromBlock() { this.rewound = true; this.current = null; }
}
class Rpc {
  public canonicalHash: Hash = blockHash; public readonly events: RpcLog[];
  public constructor(event: RpcLog, ...rest: RpcLog[]) { this.events = [event, ...rest]; }
  public async chainId() { return 1; } public async getCode() { return hexSchema.parse("0x01"); }
  public async call() { return hexSchema.parse("0x"); } public async estimateGas() { return 1n; }
  public async tokenDecimals(address: Address) { return address === base ? 18 : 6; } public async tokenSymbol() { return null; }
  public async blockNumber() { return 12n; }
  public async block(number: bigint): Promise<RpcBlock> { return { number, hash: this.canonicalHash, timestamp: 1_700_000_000n }; }
  public async logs() { return this.events; }
  public async transactionCount() { return 0n; } public async gasPrice() { return 1n; } public async maxPriorityFeePerGas() { return 1n; }
  public async sendRawTransaction() { return transactionHash; } public async transactionReceipt() { return null; }
}

const shippedLog = (): RpcLog => {
  const program = buildLimitProgram({ sellToken: base, buyToken: quote, sellAmount: 10n ** 18n, buyAmount: 2_500n * 10n ** 6n, expiresAtSeconds: 2_000_000_000n, salt, fill: { type: "partial" } });
  const strategy = encodeOrder({ maker, traits: 0n, data: program });
  const data = Abi.Tuple.create(Abi.Address, Abi.Address, Abi.Bytes32, Abi.Bytes).fromOrThrow([
    addressToBigInt(maker), addressToBigInt(router), hexToBytes(hashSchema.parse(`0x${"99".repeat(32)}`)), hexToBytes(strategy),
  ]).encodeOrThrow();
  return { address: aqua, topics: [AQUA_EVENT_TOPICS.shipped], data: hexSchema.parse(`0x${data}`), blockNumber: 10n, blockHash, transactionHash, logIndex: 0n };
};

const strategyHash = hashSchema.parse(`0x${"99".repeat(32)}`);
const dockedLog = (): RpcLog => {
  const data = Abi.Tuple.create(Abi.Address, Abi.Address, Abi.Bytes32).fromOrThrow([
    addressToBigInt(maker), addressToBigInt(router), hexToBytes(strategyHash),
  ]).encodeOrThrow();
  return { address: aqua, topics: [AQUA_EVENT_TOPICS.docked], data: hexSchema.parse(`0x${data}`), blockNumber: 10n, blockHash, transactionHash, logIndex: 1n };
};

const swappedLog = (): RpcLog => {
  const taker = addressSchema.parse("0x6666666666666666666666666666666666666666");
  const data = Abi.Tuple.create(Abi.Bytes32, Abi.Address, Abi.Address, Abi.Address, Abi.Address, Abi.Uint256, Abi.Uint256).fromOrThrow([
    hexToBytes(strategyHash), addressToBigInt(maker), addressToBigInt(taker), addressToBigInt(base), addressToBigInt(quote), 10n ** 18n, 2_500n * 10n ** 6n,
  ]).encodeOrThrow();
  return { address: router, topics: [AQUA_EVENT_TOPICS.swapped], data: hexSchema.parse(`0x${data}`), blockNumber: 10n, blockHash, transactionHash, logIndex: 2n };
};

describe("confirmed Aqua order projection", () => {
  test("projects an allowlisted shipped limit strategy into human decimal book data", async () => {
    const repository = new Repository(); const rpc = new Rpc(shippedLog());
    const indexer = new OrderBookIndexer(repository, rpc, { chainId: 1, contracts: [aqua, router], limitRouters: [router], pairs: [{ baseToken: base, quoteToken: quote }], startBlock: 10n, confirmations: 2n, blockChunkSize: 100n });
    await indexer.runOnce();
    expect(repository.projection?.orders[0]?.price).toBe("2500");
    expect(repository.projection?.orders[0]?.originalBaseAmount).toBe("1");
  });

  test("rewinds when the persisted checkpoint is no longer canonical", async () => {
    const repository = new Repository(); repository.current = { blockNumber: "9", blockHash };
    const rpc = new Rpc(shippedLog()); rpc.canonicalHash = hashSchema.parse(`0x${"aa".repeat(32)}`);
    await new OrderBookIndexer(repository, rpc, { chainId: 1, contracts: [aqua], limitRouters: [router], pairs: [{ baseToken: base, quoteToken: quote }], startBlock: 10n, confirmations: 2n, blockChunkSize: 100n }).runOnce();
    expect(repository.rewound).toBeTrue();
  });

  test("projects Docked into closedOrderHashes and Swapped into fillUpdates", async () => {
    const repository = new Repository();
    const rpc = new Rpc(shippedLog(), dockedLog(), swappedLog());
    const indexer = new OrderBookIndexer(repository, rpc, { chainId: 1, contracts: [aqua, router], limitRouters: [router], pairs: [{ baseToken: base, quoteToken: quote }], startBlock: 10n, confirmations: 2n, blockChunkSize: 100n });
    await indexer.runOnce();
    expect(repository.projection?.closedOrderHashes).toEqual([strategyHash]);
    expect(repository.projection?.fillUpdates[0]?.filledBaseAmount).toBe((10n ** 18n).toString(10));
    expect(repository.projection?.fills).toHaveLength(1);
  });
});
