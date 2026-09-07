import { Abi, ZeroHexAsInteger } from "@hazae41/cubane";
import { addressSchema, hashSchema, hexSchema } from "@aqua/core";
import type { Address, Hash, Hex } from "@aqua/core";
import { addressToBigInt, bytesToHex, concatHex, hexToBytes, keccakHex, selector } from "./hex.ts";
import type { AquaIntentAuthorization } from "./crypto.ts";

export interface SwapVmOrder {
  readonly maker: Address;
  readonly traits: bigint;
  readonly data: Hex;
}

export interface QuoteResult {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly orderHash: Hash;
}

const orderFactory = Abi.Tuple.create(Abi.Address, Abi.Uint256, Abi.Bytes);
const orderDecodeFactory = Abi.Tuple.create(Abi.Uint160, Abi.Uint256, Abi.Bytes);

const asOrderInput = (order: SwapVmOrder): readonly [bigint, bigint, Uint8Array] =>
  [addressToBigInt(order.maker), order.traits, hexToBytes(order.data)];

export const encodeOrder = (order: SwapVmOrder): Hex => {
  const encoded: string = Abi.Tuple.create(orderFactory).fromOrThrow([asOrderInput(order)]).encodeOrThrow();
  return hexSchema.parse(`0x${encoded}`);
};

export const decodeOrder = (encoded: Hex): SwapVmOrder => {
  const decoded = Abi.decodeOrThrow(
    Abi.Tuple.create(orderDecodeFactory),
    ZeroHexAsInteger.fromOrThrow(encoded),
  ).intoOrThrow();
  const order = decoded[0];
  return {
    maker: addressSchema.parse(`0x${order[0].toString(16).padStart(40, "0")}`),
    traits: order[1],
    data: bytesToHex(order[2]),
  };
};

const encodeCall = (signature: string, encodedArguments: string): Hex =>
  concatHex(selector(signature), hexSchema.parse(`0x${encodedArguments}`));

export const encodeApprove = (spender: Address, amount: bigint): Hex => encodeCall(
  "approve(address,uint256)",
  Abi.Tuple.create(Abi.Address, Abi.Uint256)
    .fromOrThrow([addressToBigInt(spender), amount]).encodeOrThrow(),
);

export const encodeWithdraw = (amount: bigint): Hex => encodeCall(
  "withdraw(uint256)",
  Abi.Tuple.create(Abi.Uint256).fromOrThrow([amount]).encodeOrThrow(),
);

export const encodeAllowance = (owner: Address, spender: Address): Hex => encodeCall(
  "allowance(address,address)",
  Abi.Tuple.create(Abi.Address, Abi.Address)
    .fromOrThrow([addressToBigInt(owner), addressToBigInt(spender)]).encodeOrThrow(),
);

export const encodeBalanceOf = (owner: Address): Hex => encodeCall(
  "balanceOf(address)", Abi.Tuple.create(Abi.Address).fromOrThrow([addressToBigInt(owner)]).encodeOrThrow(),
);

export const encodeIsValidSignature = (digest: Hash, signature: Hex): Hex => encodeCall(
  "isValidSignature(bytes32,bytes)",
  Abi.Tuple.create(Abi.Bytes32, Abi.Bytes)
    .fromOrThrow([hexToBytes(digest), hexToBytes(signature)]).encodeOrThrow(),
);

export const decodeUint256 = (encoded: Hex): bigint => Abi.decodeOrThrow(
  Abi.Tuple.create(Abi.Uint256), ZeroHexAsInteger.fromOrThrow(encoded),
).intoOrThrow()[0];

export const decodeString = (encoded: Hex): string => Abi.decodeOrThrow(
  Abi.Tuple.create(Abi.String), ZeroHexAsInteger.fromOrThrow(encoded),
).intoOrThrow()[0];

export const encodeSwapVmCall = (
  method: "quote" | "swap",
  order: SwapVmOrder,
  tokenIn: Address,
  tokenOut: Address,
  amount: bigint,
  takerTraits: Hex,
): Hex => encodeCall(
  `${method}((address,uint256,bytes),address,address,uint256,bytes)`,
  Abi.Tuple.create(orderFactory, Abi.Address, Abi.Address, Abi.Uint256, Abi.Bytes)
    .fromOrThrow([
      asOrderInput(order), addressToBigInt(tokenIn), addressToBigInt(tokenOut), amount,
      hexToBytes(takerTraits),
    ]).encodeOrThrow(),
);

export const decodeQuoteResult = (encoded: Hex): QuoteResult => {
  const decoded = Abi.decodeOrThrow(
    Abi.Tuple.create(Abi.Uint256, Abi.Uint256, Abi.Bytes32),
    ZeroHexAsInteger.fromOrThrow(encoded),
  ).intoOrThrow();
  return { amountIn: decoded[0], amountOut: decoded[1], orderHash: hashSchema.parse(bytesToHex(decoded[2])) };
};

export const orderHash = (order: SwapVmOrder): Hash => keccakHex(hexToBytes(encodeOrder(order)));

export const encodeShip = (
  app: Address,
  strategy: Hex,
  tokens: readonly [Address, Address],
  amounts: readonly [bigint, bigint],
): Hex => encodeCall(
  "ship(address,bytes,address[],uint256[])",
  Abi.Tuple.create(Abi.Address, Abi.Bytes, Abi.Vector.create(Abi.Address), Abi.Vector.create(Abi.Uint256))
    .fromOrThrow([
      addressToBigInt(app), hexToBytes(strategy),
      tokens.map(addressToBigInt), amounts,
    ]).encodeOrThrow(),
);

export const encodeDock = (
  app: Address,
  strategyHash: Hash,
  tokens: readonly [Address, Address],
): Hex => encodeCall(
  "dock(address,bytes32,address[])",
  Abi.Tuple.create(Abi.Address, Abi.Bytes32, Abi.Vector.create(Abi.Address))
    .fromOrThrow([addressToBigInt(app), hexToBytes(strategyHash), tokens.map(addressToBigInt)])
    .encodeOrThrow(),
);

const hashUtf8 = (value: string): Hash => keccakHex(new TextEncoder().encode(value));
const DOMAIN_TYPEHASH = hashUtf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
const INTENT_TYPEHASH = hashUtf8("AquaIntent(address maker,bytes32 commandHash,bytes32 nonce,uint256 validBefore)");

/** Produces the exact EIP-712 0x1901 preimage for the fixed aqua-intent-v1 language. */
export const encodeAquaIntentPreimage = (intent: AquaIntentAuthorization): Hex => {
  const domainEncoded = Abi.Tuple.create(Abi.Bytes32, Abi.Bytes32, Abi.Bytes32, Abi.Uint256, Abi.Address)
    .fromOrThrow([
      hexToBytes(DOMAIN_TYPEHASH), hexToBytes(hashUtf8("Aqua Agent Order Book")), hexToBytes(hashUtf8("1")),
      BigInt(intent.chainId), addressToBigInt(intent.controller),
    ]).encodeOrThrow();
  const messageEncoded = Abi.Tuple.create(Abi.Bytes32, Abi.Address, Abi.Bytes32, Abi.Bytes32, Abi.Uint256)
    .fromOrThrow([
      hexToBytes(INTENT_TYPEHASH), addressToBigInt(intent.maker), hexToBytes(intent.commandHash),
      hexToBytes(intent.nonce), intent.validBefore,
    ]).encodeOrThrow();
  return concatHex(
    hexSchema.parse("0x1901"),
    keccakHex(hexToBytes(hexSchema.parse(`0x${domainEncoded}`))),
    keccakHex(hexToBytes(hexSchema.parse(`0x${messageEncoded}`))),
  );
};

export const encodeObserveTrigger = (intentHash: Hash, proofHash: Hash, conditionTrue: boolean): Hex => encodeCall(
  "observe(bytes32,bytes32,bool)", Abi.Tuple.create(Abi.Bytes32, Abi.Bytes32, Abi.Bool)
    .fromOrThrow([hexToBytes(intentHash), hexToBytes(proofHash), conditionTrue]).encodeOrThrow(),
);

export const encodeActivateTrigger = (intentHash: Hash, group: Hash, proofHash: Hash): Hex => encodeCall(
  "activate(bytes32,bytes32,bytes32)", Abi.Tuple.create(Abi.Bytes32, Abi.Bytes32, Abi.Bytes32)
    .fromOrThrow([hexToBytes(intentHash), hexToBytes(group), hexToBytes(proofHash)]).encodeOrThrow(),
);
