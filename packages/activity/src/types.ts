import type { ActivityClassification, Address, Hash } from "@aqua/core";

export interface ActivitySubscription {
  readonly owner: Address;
  readonly watchedAddress: Address;
  readonly active: boolean;
  readonly nextBlock: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastProcessedBlock?: bigint;
  readonly lastProcessedBlockHash?: Hash;
}

export interface TokenMetadata { readonly decimals: number; readonly symbol: string | null }

export interface TokenAction {
  readonly id: string;
  readonly owner: Address;
  readonly watchedAddress: Address;
  readonly token: Address;
  readonly tokenDecimals: number;
  readonly tokenSymbol: string | null;
  readonly amount: string;
  readonly amountUnits: string;
  readonly classification: ActivityClassification;
  readonly classificationSource: "transferSemantics" | "inferredCounterflow";
  readonly counterparty: Address;
  readonly transactionHash: Hash;
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly logIndex: bigint;
  readonly occurredAt: Date;
  readonly confirmations: bigint;
}

export interface ActionFilter {
  readonly owner: Address;
  readonly watchedAddress?: Address;
  readonly classification?: ActivityClassification;
  readonly from?: Date;
  readonly to?: Date;
  readonly cursor?: { readonly occurredAt: Date; readonly id: string };
  readonly limit: number;
}

export interface ActionPage { readonly items: readonly TokenAction[]; readonly hasMore: boolean }

export interface ActivityRepository {
  subscribe(owner: Address, watchedAddress: Address, firstBlock: bigint, now: Date): Promise<{ readonly subscription: ActivitySubscription; readonly created: boolean }>;
  unsubscribe(owner: Address, watchedAddress: Address, now: Date): Promise<boolean>;
  listSubscriptions(owner: Address): Promise<readonly ActivitySubscription[]>;
  listActiveSubscriptions(limit: number): Promise<readonly ActivitySubscription[]>;
  storeBatch(subscription: ActivitySubscription, actions: readonly TokenAction[], nextBlock: bigint, checkpointHash: Hash, now: Date): Promise<void>;
  rewind(subscription: ActivitySubscription, nextBlock: bigint, now: Date): Promise<void>;
  listActions(filter: ActionFilter): Promise<ActionPage>;
  wipe(owner: Address, watchedAddress?: Address): Promise<bigint>;
  acquireLease(name: string, holder: string, now: Date, until: Date): Promise<boolean>;
}

export interface ActivityChain {
  safeHead(confirmations: bigint): Promise<bigint>;
  firstBlockAtOrAfter(timestamp: bigint, upperBound: bigint): Promise<bigint>;
  transfers(watchedAddress: Address, fromBlock: bigint, toBlock: bigint): Promise<readonly ChainTransfer[]>;
  blockTimestamp(blockNumber: bigint): Promise<Date>;
  blockHash(blockNumber: bigint): Promise<Hash>;
  tokenMetadata(token: Address): Promise<TokenMetadata>;
}

export interface ChainTransfer extends RawTransfer {
  readonly blockNumber: bigint;
  readonly blockHash: Hash;
}

import type { RawTransfer } from "./classify.ts";
