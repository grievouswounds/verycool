import type * as z from "zod";

/** Nominal type helper; Zod applies the marker after runtime validation. */
export type Brand<Value, Name extends string> = Value & z.core.$brand<Name>;

export type Hex = Brand<string, "Hex">;
export type Address = Brand<Hex, "Address">;
export type Hash = Brand<Hex, "Hash">;
export type Quantity = Brand<string, "Quantity">;
export type DecimalAmount = Brand<string, "DecimalAmount">;

export interface UnsignedTransaction {
  readonly to: Address;
  readonly data: Hex;
  readonly value: Quantity;
  readonly from: Address;
  readonly chainId: number;
  readonly gas?: Quantity;
}

export interface Quote {
  readonly amountIn: DecimalAmount;
  readonly amountOut: DecimalAmount;
  readonly orderHash: Hash;
}

export interface RpcCall {
  readonly to: Address;
  readonly data: Hex;
  readonly from?: Address;
  readonly value?: Quantity;
}

export interface RpcPort {
  chainId(): Promise<number>;
  getCode(address: Address): Promise<Hex>;
  call(transaction: RpcCall): Promise<Hex>;
  estimateGas(transaction: RpcCall): Promise<bigint>;
  tokenDecimals(address: Address): Promise<number>;
  tokenSymbol(address: Address): Promise<string | null>;
  blockNumber(): Promise<bigint>;
  block(number: bigint): Promise<RpcBlock>;
  logs(filter: RpcLogFilter): Promise<readonly RpcLog[]>;
  transactionCount(address: Address): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  maxPriorityFeePerGas(): Promise<bigint>;
  sendRawTransaction(transaction: Hex): Promise<Hash>;
  transactionReceipt(hash: Hash): Promise<RpcReceipt | null>;
}

export interface RpcReceipt { readonly transactionHash: Hash; readonly blockNumber: bigint; readonly status: "success" | "reverted" }

export interface RpcBlock {
  readonly number: bigint;
  readonly hash: Hash;
  readonly timestamp: bigint;
}

export interface RpcLogFilter {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly address?: Address | readonly Address[];
  readonly topics: readonly (Hash | null)[];
}

export interface RpcLog {
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly blockHash: Hash;
  readonly transactionHash: Hash;
  readonly logIndex: bigint;
  readonly data: Hex;
  readonly topics: readonly Hash[];
}

export interface Clock {
  now(): Date;
}

export interface AuthenticatedPrincipal {
  readonly address: Address;
  readonly scopes: ReadonlySet<AuthenticationScope>;
  readonly sessionId: string;
}

export const AUTHENTICATION_SCOPES = [
  "trading:read", "trading:write", "activity:read", "activity:write",
] as const;

export type AuthenticationScope = typeof AUTHENTICATION_SCOPES[number];
