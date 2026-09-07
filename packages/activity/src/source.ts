import { addressSchema, hashSchema, hexSchema, validationError } from "@aqua/core";
import type { Address, RpcPort } from "@aqua/core";
import { formatTokenAmount } from "@aqua/core";
import { keccakHex } from "@aqua/evm";
import type { ActivityChain, ChainTransfer, TokenMetadata } from "./types.ts";

const TRANSFER_TOPIC = keccakHex(new TextEncoder().encode("Transfer(address,address,uint256)"));
const ZERO_TOPIC_PREFIX = "0".repeat(24);

const addressTopic = (address: Address) => hashSchema.parse(`0x${ZERO_TOPIC_PREFIX}${address.slice(2)}`);
const topicAddress = (topic: string): Address => {
  if (topic.length !== 66 || topic.slice(2, 26) !== ZERO_TOPIC_PREFIX) throw validationError("Transfer topic contains a non-canonical address");
  return addressSchema.parse(`0x${topic.slice(26)}`);
};

export class RpcActivityChain implements ActivityChain {
  private readonly rpc: RpcPort;
  private readonly metadataCache = new Map<Address, Promise<TokenMetadata>>();
  private readonly timestampCache = new Map<bigint, Promise<Date>>();

  public constructor(rpc: RpcPort) { this.rpc = rpc; }

  public async safeHead(confirmations: bigint): Promise<bigint> {
    const head = await this.rpc.blockNumber();
    return head > confirmations ? head - confirmations : 0n;
  }

  public async firstBlockAtOrAfter(timestamp: bigint, upperBound: bigint): Promise<bigint> {
    let low = 0n;
    let high = upperBound;
    while (low < high) {
      const middle = (low + high) / 2n;
      if ((await this.rpc.block(middle)).timestamp < timestamp) low = middle + 1n;
      else high = middle;
    }
    return low;
  }

  public async transfers(watchedAddress: Address, fromBlock: bigint, toBlock: bigint): Promise<readonly ChainTransfer[]> {
    const watchedTopic = addressTopic(watchedAddress);
    const [outgoing, incoming] = await Promise.all([
      this.rpc.logs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, watchedTopic] }),
      this.rpc.logs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, null, watchedTopic] }),
    ]);
    const unique = new Map<string, ChainTransfer>();
    for (const log of [...outgoing, ...incoming]) {
      if (log.topics.length !== 3 || log.data.length !== 66 || log.topics[0] !== TRANSFER_TOPIC) {
        throw validationError("Malformed ERC-20 Transfer log");
      }
      const item: ChainTransfer = {
        token: log.address, from: topicAddress(log.topics[1] ?? ""), to: topicAddress(log.topics[2] ?? ""),
        amount: BigInt(hexSchema.parse(log.data)), transactionHash: log.transactionHash,
        logIndex: log.logIndex, blockNumber: log.blockNumber, blockHash: log.blockHash,
      };
      unique.set(`${item.transactionHash}:${String(item.logIndex)}`, item);
    }
    return [...unique.values()].sort((left, right) => left.blockNumber === right.blockNumber
      ? Number(left.logIndex - right.logIndex) : Number(left.blockNumber - right.blockNumber));
  }

  public async blockTimestamp(blockNumber: bigint): Promise<Date> {
    const cached = this.timestampCache.get(blockNumber);
    if (cached !== undefined) return cached;
    const pending = this.rpc.block(blockNumber).then((block) => new Date(Number(block.timestamp) * 1_000));
    this.timestampCache.set(blockNumber, pending);
    return pending;
  }

  public async blockHash(blockNumber: bigint) { return (await this.rpc.block(blockNumber)).hash; }

  public async tokenMetadata(token: Address): Promise<TokenMetadata> {
    const cached = this.metadataCache.get(token);
    if (cached !== undefined) return cached;
    const pending = Promise.all([this.rpc.tokenDecimals(token), this.rpc.tokenSymbol(token)])
      .then(([decimals, symbol]) => ({ decimals, symbol }));
    this.metadataCache.set(token, pending);
    try { return await pending; }
    catch (error: unknown) { this.metadataCache.delete(token); throw error; }
  }
}

export { formatTokenAmount };
