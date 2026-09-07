import { AppError, formatTokenAmount } from "@aqua/core";
import type { ActivityListQuery, ActivityWipe, Address, AuthenticatedPrincipal } from "@aqua/core";
import { classifyTransfers } from "./classify.ts";
import type { ActionFilter, ActivityChain, ActivityRepository, ActivitySubscription, TokenAction } from "./types.ts";

const encodeCursor = (action: TokenAction): string => Buffer.from(`${action.occurredAt.toISOString()}|${action.id}`, "utf8").toString("base64url");
const decodeCursor = (cursor: string): { readonly occurredAt: Date; readonly id: string } => {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator < 0 || decoded.slice(separator + 1).includes("|")) throw new Error("Invalid activity cursor");
  const occurredAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (!Number.isFinite(occurredAt.getTime()) || !/^[0-9a-f]{64}:[0-9]+$/u.test(id)) throw new Error("Invalid activity cursor");
  return { occurredAt, id };
};
const subscriptionView = (value: ActivitySubscription) => ({
  address: value.watchedAddress, active: value.active, nextBlock: value.nextBlock.toString(10),
  createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(),
  lastProcessedBlock: value.lastProcessedBlock?.toString(10) ?? null,
  lastProcessedBlockHash: value.lastProcessedBlockHash ?? null,
});

export class ActivityService {
  private readonly repository: ActivityRepository;
  private readonly chain: ActivityChain;
  private readonly confirmations: bigint;
  private readonly maxSubscriptions: number;
  private readonly now: () => Date;

  public constructor(
    repository: ActivityRepository, chain: ActivityChain, confirmations: bigint,
    maxSubscriptions: number, now: () => Date = () => new Date(),
  ) {
    this.repository = repository; this.chain = chain; this.confirmations = confirmations;
    this.maxSubscriptions = maxSubscriptions; this.now = now;
  }

  public async subscribe(address: Address, principal: AuthenticatedPrincipal) {
    const current = await this.repository.listSubscriptions(principal.address);
    if (!current.some((item) => item.watchedAddress === address && item.active) && current.filter((item) => item.active).length >= this.maxSubscriptions) {
      throw new AppError(429, "urn:aqua:error:subscription-limit", "Subscription limit reached");
    }
    const head = await this.chain.safeHead(this.confirmations);
    const startTimestamp = BigInt(Math.floor(this.now().getTime() / 1_000) - 60);
    const firstBlock = await this.chain.firstBlockAtOrAfter(startTimestamp, head);
    const result = await this.repository.subscribe(principal.address, address, firstBlock, this.now());
    return { created: result.created, subscription: subscriptionView(result.subscription) };
  }

  public unsubscribe(address: Address, principal: AuthenticatedPrincipal) {
    return this.repository.unsubscribe(principal.address, address, this.now());
  }

  public listSubscriptions(principal: AuthenticatedPrincipal) {
    return this.repository.listSubscriptions(principal.address).then((items) => items.map(subscriptionView));
  }

  public async listActions(query: ActivityListQuery, principal: AuthenticatedPrincipal) {
    const filter: ActionFilter = {
      owner: principal.address, limit: query.limit,
      ...(query.address === undefined ? {} : { watchedAddress: query.address }),
      ...(query.classification === undefined ? {} : { classification: query.classification }),
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      ...(query.cursor === undefined ? {} : { cursor: decodeCursor(query.cursor) }),
    };
    const page = await this.repository.listActions(filter);
    const last = page.items.at(-1);
    return {
      items: page.items.map((item) => ({
        id: item.id, watchedAddress: item.watchedAddress,
        token: { address: item.token, decimals: item.tokenDecimals, symbol: item.tokenSymbol },
        amount: item.amount, amountUnits: item.amountUnits, classification: item.classification,
        classificationSource: item.classificationSource, counterparty: item.counterparty,
        transactionHash: item.transactionHash, blockHash: item.blockHash,
        blockNumber: item.blockNumber.toString(10), logIndex: item.logIndex.toString(10),
        occurredAt: item.occurredAt.toISOString(), confirmations: item.confirmations.toString(10),
      })),
      nextCursor: page.hasMore && last !== undefined ? encodeCursor(last) : null,
    };
  }

  public wipe(input: ActivityWipe, principal: AuthenticatedPrincipal) {
    return this.repository.wipe(principal.address, input.scope === "address" ? input.address : undefined);
  }
}

export interface CollectorConfiguration { readonly confirmations: bigint; readonly blockChunkSize: bigint; readonly subscriptionBatchSize: number }

export class ActivityCollector {
  private readonly repository: ActivityRepository;
  private readonly chain: ActivityChain;
  private readonly config: CollectorConfiguration;
  private readonly now: () => Date;

  public constructor(repository: ActivityRepository, chain: ActivityChain, config: CollectorConfiguration, now: () => Date = () => new Date()) {
    this.repository = repository; this.chain = chain; this.config = config; this.now = now;
  }

  public async runOnce(): Promise<void> {
    const head = await this.chain.safeHead(this.config.confirmations);
    const subscriptions = await this.repository.listActiveSubscriptions(this.config.subscriptionBatchSize);
    await Promise.allSettled(subscriptions.map(async (subscription) => {
      if (subscription.nextBlock > head) return;
      if (subscription.lastProcessedBlock !== undefined && subscription.lastProcessedBlockHash !== undefined
        && await this.chain.blockHash(subscription.lastProcessedBlock) !== subscription.lastProcessedBlockHash) {
        const rewindBy = this.config.confirmations + 1n;
        const rewindTo = subscription.lastProcessedBlock > rewindBy ? subscription.lastProcessedBlock - rewindBy : 0n;
        await this.repository.rewind(subscription, rewindTo, this.now());
        return;
      }
      const end = subscription.nextBlock + this.config.blockChunkSize - 1n < head ? subscription.nextBlock + this.config.blockChunkSize - 1n : head;
      await this.collect(subscription, end, head);
    }));
  }

  private async collect(subscription: ActivitySubscription, end: bigint, head: bigint): Promise<void> {
    const transfers = await this.chain.transfers(subscription.watchedAddress, subscription.nextBlock, end);
    const transactions = Map.groupBy(transfers, (item) => item.transactionHash);
    const actions: TokenAction[] = [];
    for (const transactionTransfers of transactions.values()) {
      for (const transfer of classifyTransfers(subscription.watchedAddress, transactionTransfers)) {
        const [metadata, occurredAt] = await Promise.all([this.chain.tokenMetadata(transfer.token), this.chain.blockTimestamp(transfer.blockNumber)]);
        const incoming = transfer.to === subscription.watchedAddress;
        actions.push({
          id: `${transfer.transactionHash.slice(2)}:${String(transfer.logIndex)}`, owner: subscription.owner,
          watchedAddress: subscription.watchedAddress, token: transfer.token, tokenDecimals: metadata.decimals,
          tokenSymbol: metadata.symbol, amount: formatTokenAmount(transfer.amount, metadata.decimals),
          amountUnits: transfer.amount.toString(10), classification: transfer.classification,
          classificationSource: transfer.classificationSource,
          counterparty: incoming ? transfer.from : transfer.to, transactionHash: transfer.transactionHash,
          blockHash: transfer.blockHash, blockNumber: transfer.blockNumber, logIndex: transfer.logIndex,
          occurredAt, confirmations: head - transfer.blockNumber + 1n,
        });
      }
    }
    await this.repository.storeBatch(subscription, actions, end + 1n, await this.chain.blockHash(end), this.now());
  }
}
