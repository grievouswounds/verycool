import type { Address, Hash, Hex, TradingOrder, TradingRequest, UnsignedTransaction } from "@aqua/core";

export type OrderStatus = "pending" | "open" | "partiallyFilled" | "filled" | "cancelled" | "expired" | "rejected";

export interface IndexedOrder {
  readonly id: string;
  readonly chainId: string;
  readonly maker: Address;
  readonly router: Address;
  readonly orderHash: Hash;
  readonly encodedOrder: Hex;
  readonly baseToken: Address;
  readonly quoteToken: Address;
  readonly side: "buy" | "sell";
  readonly price: string;
  readonly originalBaseAmount: string;
  readonly remainingBaseAmount: string;
  readonly originalBaseUnits: string;
  readonly remainingBaseUnits: string;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
  readonly status: OrderStatus;
  readonly blockNumber: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IndexedFill {
  readonly id: string;
  readonly orderId: string;
  readonly transactionHash: Hash;
  readonly maker: Address;
  readonly taker: Address;
  readonly baseToken: Address;
  readonly quoteToken: Address;
  readonly baseAmount: string;
  readonly quoteAmount: string;
  readonly price: string;
  readonly blockNumber: string;
  readonly occurredAt: string;
}

export interface AuthorizationRequirement {
  readonly profile: "aqua-intent-v1";
  readonly authorizationId: string;
  readonly validBefore: string;
  readonly typedData: Readonly<Record<string, unknown>>;
  readonly requiredTransactions: readonly UnsignedTransaction[];
}

export interface StoredIntent {
  readonly id: string;
  readonly maker: Address;
  readonly commandHash: Hash;
  readonly command: TradingRequest;
  readonly status: "awaitingAuthorization" | "active" | "cancelled" | "executed" | "expired";
  readonly nonce: Hash;
  readonly validBefore: Date;
  readonly signature?: Hex;
}

export interface BookPage<Item> { readonly items: readonly Item[]; readonly nextCursor: string | null }
export interface BookLevel { readonly price: string; readonly baseAmount: string; readonly orderCount: string }

export interface ChainCheckpoint {
  readonly blockNumber: string;
  readonly blockHash: Hash;
}

export interface IndexedProtocolLog {
  readonly id: string;
  readonly address: Address;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly transactionHash: Hash;
  readonly logIndex: string;
  readonly topic0: Hash;
  readonly topics: readonly Hash[];
  readonly data: Hex;
}

export interface OrderFillUpdate {
  readonly orderId: string;
  readonly filledBaseAmount: string;
  readonly blockNumber: string;
  readonly updatedAt: string;
}

export interface ProtocolProjection {
  readonly logs: readonly IndexedProtocolLog[];
  readonly orders: readonly IndexedOrder[];
  readonly fills: readonly IndexedFill[];
  readonly fillUpdates: readonly OrderFillUpdate[];
  readonly closedOrderHashes: readonly Hash[];
}

export interface TradingRepository {
  getOrder(id: string): Promise<IndexedOrder | null>;
  getOrderByHash(hash: Hash, router: Address): Promise<IndexedOrder | null>;
  listOrders(owner: Address | null, status: OrderStatus | null, limit: number, cursor?: string): Promise<BookPage<IndexedOrder>>;
  listFills(owner: Address | null, orderId: string | null, limit: number, cursor?: string): Promise<BookPage<IndexedFill>>;
  listPairFills(baseToken: Address, quoteToken: Address, limit: number, cursor?: string): Promise<BookPage<IndexedFill>>;
  listPairOrders(baseToken: Address, quoteToken: Address): Promise<readonly IndexedOrder[]>;
  saveRequirement(intent: StoredIntent): Promise<void>;
  getRequirement(id: string): Promise<StoredIntent | null>;
  listActiveIntents(limit: number): Promise<readonly StoredIntent[]>;
  consumeRequirement(id: string, commandHash: Hash, maker: Address, signature: Hex, now: Date): Promise<StoredIntent | null>;
  saveIndexedOrders(orders: readonly IndexedOrder[]): Promise<void>;
  saveFills(fills: readonly IndexedFill[]): Promise<void>;
  checkpoint(): Promise<ChainCheckpoint | null>;
  commitProjection(projection: ProtocolProjection, checkpoint: ChainCheckpoint): Promise<void>;
  rewindFromBlock(blockNumber: bigint): Promise<void>;
}

export interface ProtocolGateway {
  prepareLimitFromTrading(order: TradingOrder, maker: Address): Promise<unknown>;
  prepareMarketRoute(order: TradingOrder, selected: readonly IndexedOrder[], maker: Address): Promise<unknown>;
  prepareSwap(swap: Extract<TradingRequest, { readonly action: "prepareSwap" }>["swap"], maker: Address): Promise<unknown>;
  prepareCancellation(order: IndexedOrder, maker: Address): unknown;
  prepareWrappedNative(operation: "wrap" | "unwrap", amount: string, maker: Address): Promise<unknown>;
  queryBalances(tokens: readonly Address[], maker: Address, orders: readonly IndexedOrder[]): Promise<unknown>;
}
