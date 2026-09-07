import { formatTokenAmount } from "@aqua/core";
import type { Address, Hash, RpcLog, RpcPort } from "@aqua/core";
import { AQUA_EVENT_TOPICS, decodeProtocolEvent, recognizeLimitStrategy } from "@aqua/contracts";
import type { IndexedFill, IndexedOrder, IndexedProtocolLog, OrderFillUpdate, ProtocolProjection, TradingRepository } from "./types.ts";

export interface IndexedPair { readonly baseToken: Address; readonly quoteToken: Address }
export interface OrderIndexerConfiguration {
  readonly chainId: number;
  readonly contracts: readonly Address[];
  readonly limitRouters: readonly Address[];
  readonly pairs: readonly IndexedPair[];
  readonly startBlock: bigint;
  readonly confirmations: bigint;
  readonly blockChunkSize: bigint;
}

const knownTopics = new Set<Hash>(Object.values(AQUA_EVENT_TOPICS));
const ratio = (numerator: bigint, denominator: bigint): string => {
  if (numerator <= 0n || denominator <= 0n) throw new Error("Price ratio must be positive");
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return whole.toString(10);
  const fraction = (remainder * 10n ** 36n / denominator).toString(10).padStart(36, "0").replace(/0+$/u, "");
  return `${whole.toString(10)}.${fraction}`;
};

const rawLog = (log: RpcLog): IndexedProtocolLog => {
  const topic0 = log.topics[0];
  if (topic0 === undefined) throw new Error("Protocol log has no event signature");
  return {
    id: `${log.transactionHash}:${log.logIndex.toString(10)}`, address: log.address,
    blockNumber: log.blockNumber.toString(10), blockHash: log.blockHash,
    transactionHash: log.transactionHash, logIndex: log.logIndex.toString(10), topic0,
    topics: log.topics, data: log.data,
  };
};

/** Reorg-aware exact event recognition and projection for allowlisted limit strategies. */
export class OrderBookIndexer {
  private readonly repository: TradingRepository;
  private readonly rpc: RpcPort;
  private readonly config: OrderIndexerConfiguration;

  public constructor(repository: TradingRepository, rpc: RpcPort, config: OrderIndexerConfiguration) {
    this.repository = repository; this.rpc = rpc; this.config = config;
  }

  public async runOnce(): Promise<void> {
    let checkpoint = await this.repository.checkpoint();
    if (checkpoint !== null) {
      const canonical = await this.rpc.block(BigInt(checkpoint.blockNumber));
      if (canonical.hash !== checkpoint.blockHash) {
        await this.repository.rewindFromBlock(BigInt(checkpoint.blockNumber));
        checkpoint = null;
      }
    }
    const head = await this.rpc.blockNumber();
    if (head < this.config.confirmations) return;
    const confirmed = head - this.config.confirmations;
    const from = checkpoint === null ? this.config.startBlock : BigInt(checkpoint.blockNumber) + 1n;
    if (from > confirmed) return;
    const to = from + this.config.blockChunkSize - 1n < confirmed ? from + this.config.blockChunkSize - 1n : confirmed;
    const logs = await this.rpc.logs({ fromBlock: from, toBlock: to, address: this.config.contracts, topics: [] });
    const projection = await this.project(logs);
    const finalBlock = await this.rpc.block(to);
    await this.repository.commitProjection(projection, { blockNumber: to.toString(10), blockHash: finalBlock.hash });
  }

  private async project(logs: readonly RpcLog[]): Promise<ProtocolProjection> {
    const orders: IndexedOrder[] = []; const fills: IndexedFill[] = []; const fillUpdates: OrderFillUpdate[] = [];
    const closedOrderHashes: Hash[] = []; const orderCache = new Map<Hash, IndexedOrder>();
    for (const log of logs) {
      const topic0 = log.topics[0];
      if (topic0 === undefined || !knownTopics.has(topic0)) continue;
      const event = decodeProtocolEvent(log);
      const time = new Date(Number((await this.rpc.block(log.blockNumber)).timestamp) * 1_000).toISOString();
      if (event.kind === "shipped" && this.config.limitRouters.includes(event.app)) {
        const strategy = recognizeLimitStrategy(event.strategy);
        if (strategy.maker !== event.maker) throw new Error("Shipped strategy maker does not match event maker");
        const pair = this.resolvePair(strategy.sellToken, strategy.buyToken);
        if (pair === null) continue;
        const [baseDecimals, quoteDecimals] = await Promise.all([
          this.rpc.tokenDecimals(pair.baseToken), this.rpc.tokenDecimals(pair.quoteToken),
        ]);
        const sellingBase = strategy.sellToken === pair.baseToken;
        const baseUnits = sellingBase ? strategy.sellAmount : strategy.buyAmount;
        const quoteUnits = sellingBase ? strategy.buyAmount : strategy.sellAmount;
        const price = ratio(quoteUnits * 10n ** BigInt(baseDecimals), baseUnits * 10n ** BigInt(quoteDecimals));
        const order: IndexedOrder = {
          id: `eip155:${String(this.config.chainId)}/${event.app}/${event.strategyHash}`, chainId: `eip155:${String(this.config.chainId)}`,
          maker: event.maker, router: event.app, orderHash: event.strategyHash, encodedOrder: event.strategy,
          baseToken: pair.baseToken, quoteToken: pair.quoteToken, side: sellingBase ? "sell" : "buy", price,
          originalBaseAmount: formatTokenAmount(baseUnits, baseDecimals), remainingBaseAmount: formatTokenAmount(baseUnits, baseDecimals),
          originalBaseUnits: baseUnits.toString(10), remainingBaseUnits: baseUnits.toString(10), baseDecimals, quoteDecimals,
          status: "open", blockNumber: log.blockNumber.toString(10), createdAt: time, updatedAt: time,
        };
        orders.push(order); orderCache.set(order.orderHash, order);
      } else if (event.kind === "docked") {
        closedOrderHashes.push(event.strategyHash);
      } else if (event.kind === "swapped") {
        const cached = orderCache.get(event.orderHash);
        const order = cached?.router === log.address ? cached : await this.repository.getOrderByHash(event.orderHash, log.address);
        if (order === null) continue;
        const baseUnits = event.tokenIn === order.baseToken ? event.amountIn : event.tokenOut === order.baseToken ? event.amountOut : 0n;
        const quoteUnits = event.tokenIn === order.quoteToken ? event.amountIn : event.tokenOut === order.quoteToken ? event.amountOut : 0n;
        if (baseUnits === 0n || quoteUnits === 0n) throw new Error("Swapped event tokens do not match indexed pair");
        fills.push({
          id: `${log.transactionHash}:${log.logIndex.toString(10)}`, orderId: order.id, transactionHash: log.transactionHash,
          maker: event.maker, taker: event.taker, baseToken: order.baseToken, quoteToken: order.quoteToken,
          baseAmount: formatTokenAmount(baseUnits, order.baseDecimals),
          quoteAmount: formatTokenAmount(quoteUnits, order.quoteDecimals),
          price: ratio(quoteUnits * 10n ** BigInt(order.baseDecimals), baseUnits * 10n ** BigInt(order.quoteDecimals)),
          blockNumber: log.blockNumber.toString(10), occurredAt: time,
        });
        fillUpdates.push({ orderId: order.id, filledBaseAmount: baseUnits.toString(10), blockNumber: log.blockNumber.toString(10), updatedAt: time });
      }
    }
    return { logs: logs.filter((log) => log.topics[0] !== undefined && knownTopics.has(log.topics[0])).map(rawLog), orders, fills, fillUpdates, closedOrderHashes };
  }

  private resolvePair(sellToken: Address, buyToken: Address): IndexedPair | null {
    return this.config.pairs.find((pair) =>
      (pair.baseToken === sellToken && pair.quoteToken === buyToken) || (pair.baseToken === buyToken && pair.quoteToken === sellToken),
    ) ?? null;
  }
}
