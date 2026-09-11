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

export const encodeMint = (recipient: Address, amount: bigint): Hex => encodeCall(
  "mint(address,uint256)",
  Abi.Tuple.create(Abi.Address, Abi.Uint256)
    .fromOrThrow([addressToBigInt(recipient), amount]).encodeOrThrow(),
);

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

export interface Permit2TransferPermit {
  readonly permitted: { readonly token: Address; readonly amount: bigint };
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export interface X402ExactWitness {
  readonly to: Address;
  readonly validAfter: bigint;
}

export interface Eip2612Permit {
  readonly value: bigint;
  readonly deadline: bigint;
  readonly r: Hash;
  readonly s: Hash;
  readonly v: number;
}

const tokenPermissionFactory = Abi.Tuple.create(Abi.Address, Abi.Uint256);
const permit2TransferFactory = Abi.Tuple.create(tokenPermissionFactory, Abi.Uint256, Abi.Uint256);
const x402ExactWitnessFactory = Abi.Tuple.create(Abi.Address, Abi.Uint256);
const eip2612PermitFactory = Abi.Tuple.create(Abi.Uint256, Abi.Uint256, Abi.Bytes32, Abi.Bytes32, Abi.Uint8);
const permit2TransferInput = (permit: Permit2TransferPermit): readonly [readonly [bigint, bigint], bigint, bigint] => [
  [addressToBigInt(permit.permitted.token), permit.permitted.amount], permit.nonce, permit.deadline,
];
const x402WitnessInput = (witness: X402ExactWitness): readonly [bigint, bigint] =>
  [addressToBigInt(witness.to), witness.validAfter];

export const encodeX402ExactSettle = (
  permit: Permit2TransferPermit,
  owner: Address,
  witness: X402ExactWitness,
  signature: Hex,
): Hex => encodeCall(
  "settle(((address,uint256),uint256,uint256),address,(address,uint256),bytes)",
  Abi.Tuple.create(permit2TransferFactory, Abi.Address, x402ExactWitnessFactory, Abi.Bytes).fromOrThrow([
    permit2TransferInput(permit), addressToBigInt(owner), x402WitnessInput(witness), hexToBytes(signature),
  ]).encodeOrThrow(),
);

export const encodeX402ExactSettleWithPermit = (
  permit2612: Eip2612Permit,
  permit: Permit2TransferPermit,
  owner: Address,
  witness: X402ExactWitness,
  signature: Hex,
): Hex => encodeCall(
  "settleWithPermit((uint256,uint256,bytes32,bytes32,uint8),((address,uint256),uint256,uint256),address,(address,uint256),bytes)",
  Abi.Tuple.create(eip2612PermitFactory, permit2TransferFactory, Abi.Address, x402ExactWitnessFactory, Abi.Bytes).fromOrThrow([
    [permit2612.value, permit2612.deadline, hexToBytes(permit2612.r), hexToBytes(permit2612.s), permit2612.v],
    permit2TransferInput(permit), addressToBigInt(owner), x402WitnessInput(witness), hexToBytes(signature),
  ]).encodeOrThrow(),
);

export const decodeUint256 = (encoded: Hex): bigint => Abi.decodeOrThrow(
  Abi.Tuple.create(Abi.Uint256), ZeroHexAsInteger.fromOrThrow(encoded),
).intoOrThrow()[0];

export const decodeAddress = (encoded: Hex): Address => {
  const value = Abi.decodeOrThrow(Abi.Tuple.create(Abi.Uint160), ZeroHexAsInteger.fromOrThrow(encoded)).intoOrThrow()[0];
  return addressSchema.parse(`0x${value.toString(16).padStart(40, "0")}`);
};

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

const AGENT_BINDING_TYPEHASH = hashUtf8("AgentBinding(address owner,address agent,bytes32 nonce,uint256 validBefore)");
const TRADE_LIFECYCLE_TYPEHASH = hashUtf8("TradeLifecycle(address owner,address agent,bytes32 previewHash,bytes32 nonce,uint256 validBefore)");
const DELEGATION_TYPEHASH = hashUtf8("Delegation(address owner,address delegate,address token,uint256 maxPerOrder,uint256 maxPerDay,uint256 validUntil,uint256 nonce)");

const tradeDomain = (chainId: number, verifyingContract: Address): Hash => {
  const encoded = Abi.Tuple.create(Abi.Bytes32, Abi.Bytes32, Abi.Bytes32, Abi.Uint256, Abi.Address)
    .fromOrThrow([
      hexToBytes(DOMAIN_TYPEHASH), hexToBytes(hashUtf8("Aqua Ledger Agent Vault")), hexToBytes(hashUtf8("1")),
      BigInt(chainId), addressToBigInt(verifyingContract),
    ]).encodeOrThrow();
  return keccakHex(hexToBytes(hexSchema.parse(`0x${encoded}`)));
};

export const encodeAgentBindingPreimage = (value: { readonly chainId: number; readonly verifyingContract: Address; readonly owner: Address; readonly agent: Address; readonly nonce: Hash; readonly validBefore: bigint }): Hex => {
  const encoded = Abi.Tuple.create(Abi.Bytes32, Abi.Address, Abi.Address, Abi.Bytes32, Abi.Uint256).fromOrThrow([
    hexToBytes(AGENT_BINDING_TYPEHASH), addressToBigInt(value.owner), addressToBigInt(value.agent), hexToBytes(value.nonce), value.validBefore,
  ]).encodeOrThrow();
  return concatHex(hexSchema.parse("0x1901"), tradeDomain(value.chainId, value.verifyingContract), keccakHex(hexToBytes(hexSchema.parse(`0x${encoded}`))));
};

export const encodeTradeLifecyclePreimage = (value: { readonly chainId: number; readonly verifyingContract: Address; readonly owner: Address; readonly agent: Address; readonly previewHash: Hash; readonly nonce: Hash; readonly validBefore: bigint }): Hex => {
  const encoded = Abi.Tuple.create(Abi.Bytes32, Abi.Address, Abi.Address, Abi.Bytes32, Abi.Bytes32, Abi.Uint256).fromOrThrow([
    hexToBytes(TRADE_LIFECYCLE_TYPEHASH), addressToBigInt(value.owner), addressToBigInt(value.agent), hexToBytes(value.previewHash), hexToBytes(value.nonce), value.validBefore,
  ]).encodeOrThrow();
  return concatHex(hexSchema.parse("0x1901"), tradeDomain(value.chainId, value.verifyingContract), keccakHex(hexToBytes(hexSchema.parse(`0x${encoded}`))));
};

export const encodeDelegationPreimage = (value: { readonly chainId: number; readonly verifyingContract: Address; readonly owner: Address; readonly delegate: Address; readonly token: Address; readonly maxPerOrder: bigint; readonly maxPerDay: bigint; readonly validUntil: bigint; readonly nonce: bigint }): Hex => {
  const encoded = Abi.Tuple.create(Abi.Bytes32, Abi.Address, Abi.Address, Abi.Address, Abi.Uint256, Abi.Uint256, Abi.Uint256, Abi.Uint256).fromOrThrow([
    hexToBytes(DELEGATION_TYPEHASH), addressToBigInt(value.owner), addressToBigInt(value.delegate), addressToBigInt(value.token), value.maxPerOrder, value.maxPerDay, value.validUntil, value.nonce,
  ]).encodeOrThrow();
  return concatHex(hexSchema.parse("0x1901"), tradeDomain(value.chainId, value.verifyingContract), keccakHex(hexToBytes(hexSchema.parse(`0x${encoded}`))));
};

export const encodeDelegationNonce = (owner: Address): Hex => encodeCall("delegationNonces(address)", Abi.Tuple.create(Abi.Address).fromOrThrow([addressToBigInt(owner)]).encodeOrThrow());

export const encodeActionNonceUsed = (delegate: Address, nonce: Hash): Hex => encodeCall(
  "actionNonceUsed(address,bytes32)", Abi.Tuple.create(Abi.Address, Abi.Bytes32).fromOrThrow([addressToBigInt(delegate), hexToBytes(nonce)]).encodeOrThrow(),
);

export const mappingStorageSlot = (key: Address | Hash, slot: bigint): Hash => {
  const encoded = Abi.Tuple.create(Abi.Bytes32, Abi.Uint256).fromOrThrow([hexToBytes(hashSchema.parse(`0x${key.slice(2).padStart(64, "0")}`)), slot]).encodeOrThrow();
  return keccakHex(hexToBytes(hexSchema.parse(`0x${encoded}`)));
};

export const erc20BalanceSlot = (account: Address, mappingSlot: bigint): Hash => mappingStorageSlot(account, mappingSlot);

export const uint256SlotValue = (value: bigint): Hash => hashSchema.parse(`0x${value.toString(16).padStart(64, "0")}`);

export interface VaultDeployment {
  readonly owner: Address;
  readonly delegate: Address;
  readonly aqua: Address;
  readonly app: Address;
  readonly sellToken: Address;
  readonly salt: Hash;
}

const encodeVaultDeployment = (signature: "predictVault" | "deployVault", value: VaultDeployment): Hex => encodeCall(
  `${signature}(address,address,address,address,address,bytes32)`,
  Abi.Tuple.create(Abi.Address, Abi.Address, Abi.Address, Abi.Address, Abi.Address, Abi.Bytes32).fromOrThrow([
    addressToBigInt(value.owner), addressToBigInt(value.delegate), addressToBigInt(value.aqua),
    addressToBigInt(value.app), addressToBigInt(value.sellToken), hexToBytes(value.salt),
  ]).encodeOrThrow(),
);

export const encodePredictVault = (value: VaultDeployment): Hex => encodeVaultDeployment("predictVault", value);
export const encodeDeployVault = (value: VaultDeployment): Hex => encodeVaultDeployment("deployVault", value);

export interface VaultAction {
  readonly vault: Address;
  readonly action: 0 | 1 | 2 | 3 | 4;
  readonly strategy: Hex;
  readonly tokens: readonly Address[];
  readonly amounts: readonly bigint[];
  readonly nonce: Hash;
  readonly deadline: bigint;
}

const vaultRequestFactory = Abi.Tuple.create(
  Abi.Address, Abi.Uint8, Abi.Bytes, Abi.Vector.create(Abi.Address), Abi.Vector.create(Abi.Uint256), Abi.Bytes32, Abi.Uint256,
);

export const encodeExecuteVaultAction = (value: VaultAction, signature: Hex): Hex => encodeCall(
  "execute((address,uint8,bytes,address[],uint256[],bytes32,uint256),bytes)",
  Abi.Tuple.create(vaultRequestFactory, Abi.Bytes).fromOrThrow([[
    addressToBigInt(value.vault), value.action, hexToBytes(value.strategy), value.tokens.map(addressToBigInt),
    value.amounts, hexToBytes(value.nonce), value.deadline,
  ], hexToBytes(signature)]).encodeOrThrow(),
);

export const encodeBoundedMatcherExecute = (targets: readonly Address[], calls: readonly Hex[]): Hex => encodeCall(
  "execute(address[],bytes[])",
  Abi.Tuple.create(Abi.Vector.create(Abi.Address), Abi.Vector.create(Abi.Bytes)).fromOrThrow([
    targets.map(addressToBigInt), calls.map(hexToBytes),
  ]).encodeOrThrow(),
);

export const hashAddressArray = (values: readonly Address[]): Hash => {
  const encoded = Abi.Tuple.create(Abi.Vector.create(Abi.Address)).fromOrThrow([values.map(addressToBigInt)]).encodeOrThrow();
  return keccakHex(hexToBytes(hexSchema.parse(`0x${encoded}`)));
};

export const hashUint256Array = (values: readonly bigint[]): Hash => {
  const encoded = Abi.Tuple.create(Abi.Vector.create(Abi.Uint256)).fromOrThrow([values]).encodeOrThrow();
  return keccakHex(hexToBytes(hexSchema.parse(`0x${encoded}`)));
};

export const encodeRegisterDelegation = (value: { readonly owner: Address; readonly delegate: Address; readonly token: Address; readonly maxPerOrder: bigint; readonly maxPerDay: bigint; readonly validUntil: bigint; readonly signature: Hex }): Hex => encodeCall(
  "registerDelegation(address,address,address,uint128,uint128,uint64,bytes)",
  Abi.Tuple.create(Abi.Address, Abi.Address, Abi.Address, Abi.Uint128, Abi.Uint128, Abi.Uint64, Abi.Bytes).fromOrThrow([
    addressToBigInt(value.owner), addressToBigInt(value.delegate), addressToBigInt(value.token), value.maxPerOrder, value.maxPerDay, value.validUntil, hexToBytes(value.signature),
  ]).encodeOrThrow(),
);

export const encodeObserveTrigger = (intentHash: Hash, proofHash: Hash, conditionTrue: boolean): Hex => encodeCall(
  "observe(bytes32,bytes32,bool)", Abi.Tuple.create(Abi.Bytes32, Abi.Bytes32, Abi.Bool)
    .fromOrThrow([hexToBytes(intentHash), hexToBytes(proofHash), conditionTrue]).encodeOrThrow(),
);

export const encodeActivateTrigger = (intentHash: Hash, group: Hash, proofHash: Hash): Hex => encodeCall(
  "activate(bytes32,bytes32,bytes32)", Abi.Tuple.create(Abi.Bytes32, Abi.Bytes32, Abi.Bytes32)
    .fromOrThrow([hexToBytes(intentHash), hexToBytes(group), hexToBytes(proofHash)]).encodeOrThrow(),
);
