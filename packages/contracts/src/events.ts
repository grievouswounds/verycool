import { Abi, ZeroHexAsInteger } from "@hazae41/cubane";
import { addressSchema, hashSchema, validationError } from "@aqua/core";
import type { Address, Hash, Hex, RpcLog } from "@aqua/core";
import { bytesToHex, hexToBytes, keccakHex } from "@aqua/evm";
import { decodeOrder } from "@aqua/evm";
import { decodeProgram } from "./program.ts";

const eventTopic = (signature: string): Hash => keccakHex(new TextEncoder().encode(signature));
export const AQUA_EVENT_TOPICS = {
  shipped: eventTopic("Shipped(address,address,bytes32,bytes)"),
  docked: eventTopic("Docked(address,address,bytes32)"),
  pulled: eventTopic("Pulled(address,address,bytes32,address,uint256)"),
  pushed: eventTopic("Pushed(address,address,bytes32,address,uint256)"),
  swapped: eventTopic("Swapped(bytes32,address,address,address,address,uint256,uint256)"),
} as const;

export type AquaProtocolEvent =
  | { readonly kind: "shipped"; readonly maker: Address; readonly app: Address; readonly strategyHash: Hash; readonly strategy: Hex }
  | { readonly kind: "docked"; readonly maker: Address; readonly app: Address; readonly strategyHash: Hash }
  | { readonly kind: "pulled" | "pushed"; readonly maker: Address; readonly app: Address; readonly strategyHash: Hash; readonly token: Address; readonly amount: bigint }
  | { readonly kind: "swapped"; readonly orderHash: Hash; readonly maker: Address; readonly taker: Address; readonly tokenIn: Address; readonly tokenOut: Address; readonly amountIn: bigint; readonly amountOut: bigint };

const digest = (value: Uint8Array): Hash => hashSchema.parse(bytesToHex(value));
const address = (value: bigint): Address => addressSchema.parse(`0x${value.toString(16).padStart(40, "0")}`);

/** Exact event recognizer: one topic only because all current Aqua/SwapVM fields are unindexed. */
export const decodeProtocolEvent = (log: RpcLog): AquaProtocolEvent => {
  if (log.topics.length !== 1) throw validationError("Protocol event must contain exactly one topic");
  const topic = log.topics[0];
  if (topic === AQUA_EVENT_TOPICS.shipped) {
    const value = Abi.decodeOrThrow(Abi.Tuple.create(Abi.Uint160, Abi.Uint160, Abi.Bytes32, Abi.Bytes), ZeroHexAsInteger.fromOrThrow(log.data)).intoOrThrow();
    return { kind: "shipped", maker: address(value[0]), app: address(value[1]), strategyHash: digest(value[2]), strategy: bytesToHex(value[3]) };
  }
  if (topic === AQUA_EVENT_TOPICS.docked) {
    const value = Abi.decodeOrThrow(Abi.Tuple.create(Abi.Uint160, Abi.Uint160, Abi.Bytes32), ZeroHexAsInteger.fromOrThrow(log.data)).intoOrThrow();
    return { kind: "docked", maker: address(value[0]), app: address(value[1]), strategyHash: digest(value[2]) };
  }
  if (topic === AQUA_EVENT_TOPICS.pulled || topic === AQUA_EVENT_TOPICS.pushed) {
    const value = Abi.decodeOrThrow(Abi.Tuple.create(Abi.Uint160, Abi.Uint160, Abi.Bytes32, Abi.Uint160, Abi.Uint256), ZeroHexAsInteger.fromOrThrow(log.data)).intoOrThrow();
    return { kind: topic === AQUA_EVENT_TOPICS.pulled ? "pulled" : "pushed", maker: address(value[0]), app: address(value[1]), strategyHash: digest(value[2]), token: address(value[3]), amount: value[4] };
  }
  if (topic === AQUA_EVENT_TOPICS.swapped) {
    const value = Abi.decodeOrThrow(Abi.Tuple.create(Abi.Bytes32, Abi.Uint160, Abi.Uint160, Abi.Uint160, Abi.Uint160, Abi.Uint256, Abi.Uint256), ZeroHexAsInteger.fromOrThrow(log.data)).intoOrThrow();
    return { kind: "swapped", orderHash: digest(value[0]), maker: address(value[1]), taker: address(value[2]), tokenIn: address(value[3]), tokenOut: address(value[4]), amountIn: value[5], amountOut: value[6] };
  }
  throw validationError("Unknown Aqua/SwapVM event topic");
};

export interface RecognizedLimitStrategy {
  readonly encodedOrder: Hex;
  readonly maker: Address;
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
}

/** Accepts only the exact five-instruction limit grammar emitted by this backend. */
export const recognizeLimitStrategy = (encodedOrder: Hex): RecognizedLimitStrategy => {
  const order = decodeOrder(encodedOrder);
  const instructions = decodeProgram(order.data);
  if (instructions.length !== 5 || instructions[0]?.opcode !== 14 || instructions[1]?.opcode !== 31
    || instructions[2]?.opcode !== 18 || !new Set([19, 21]).has(instructions[3]?.opcode ?? -1)
    || !new Set([22, 23]).has(instructions[4]?.opcode ?? -1)) throw validationError("Unrecognized limit strategy instruction grammar");
  const balanceBytes = hexToBytes(instructions[2].arguments);
  if (balanceBytes.length !== 106 || balanceBytes[0] !== 0 || balanceBytes[1] !== 2) throw validationError("Invalid static-balance instruction");
  const tokenIn = addressSchema.parse(bytesToHex(balanceBytes.slice(2, 22)));
  const tokenOut = addressSchema.parse(bytesToHex(balanceBytes.slice(22, 42)));
  const uint = (start: number): bigint => BigInt(bytesToHex(balanceBytes.slice(start, start + 32)));
  const buyAmount = uint(42); const sellAmount = uint(74);
  if (buyAmount === 0n || sellAmount === 0n) throw validationError("Limit amounts must be positive");
  return { encodedOrder, maker: order.maker, sellToken: tokenOut, buyToken: tokenIn, sellAmount, buyAmount };
};
