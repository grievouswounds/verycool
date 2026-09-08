import { Abi, Address as CubaneAddress, Keccak256, Secp256k1, SigningKey, VerifyingKey, ZeroHexAsInteger, ZeroHexSignature, ZeroHexSigningKey, recoverMessageOrThrow, recoverUnprefixedMessageOrThrow } from "@hazae41/cubane";
import * as nobleSecp256k1 from "@noble/curves/secp256k1";
import * as nobleSha3 from "@noble/hashes/sha3";
import { addressSchema, hashSchema, hexSchema } from "@aqua/core";
import type { Address, Hash, Hex } from "@aqua/core";
import { encodeAgentBindingPreimage, encodeAquaIntentPreimage, encodeDelegationPreimage, encodeTradeLifecyclePreimage } from "./abi.ts";
import { bytesToHex, hexToBytes, keccakHex } from "./hex.ts";

let initialized = false;

export const initializeCubane = (): void => {
  if (initialized) return;
  Keccak256.set(Keccak256.fromNoble(nobleSha3));
  Secp256k1.set(Secp256k1.fromNoble(nobleSecp256k1));
  if (keccakHex(new Uint8Array()) !== "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") {
    throw new Error("Cubane Keccak-256 known-answer test failed");
  }
  if (String(CubaneAddress.fromOrThrow(0x52908400098527886e0f7030069857d2e4169ee7n)) !== "0x52908400098527886E0F7030069857D2E4169EE7") {
    throw new Error("Cubane EIP-55 known-answer test failed");
  }
  initialized = true;
};

export type Eip712TypedData = Abi.Typed.TypedData;

export const randomSigningKey = (): Hex => {
  initializeCubane();
  return hexSchema.parse(ZeroHexSigningKey.fromExtOrThrow(SigningKey.randomOrThrow()));
};

export const signingKeyAddress = (key: Hex): Address => {
  initializeCubane();
  return addressSchema.parse(String(ZeroHexSigningKey.getAddressOrThrow(key)));
};

export const hashTypedData = (typedData: Eip712TypedData): Hash => {
  initializeCubane();
  using digest = Abi.Typed.TypedData.hashOrThrow(typedData);
  return hashSchema.parse(bytesToHex(digest.bytes));
};

export const signTypedData = (key: Hex, typedData: Eip712TypedData): Hex => {
  initializeCubane();
  const encoded = Abi.Typed.TypedData.encodeOrThrow(typedData);
  const signature = ZeroHexSigningKey.signUnprefixedMessageOrThrow(key, encoded);
  return hexSchema.parse(ZeroHexSignature.fromRsvOrThrow(signature));
};

export const recoverTypedDataAddress = (typedData: Eip712TypedData, signature: Hex): Address => {
  initializeCubane();
  const encoded = Abi.Typed.TypedData.encodeOrThrow(typedData);
  const key = recoverUnprefixedMessageOrThrow(ZeroHexAsInteger.fromOrThrow(signature), encoded);
  return addressSchema.parse(VerifyingKey.getAddressOrThrow(key));
};

export const recoverPersonalAddress = (message: string, signature: Hex): Address => {
  initializeCubane();
  const key = recoverMessageOrThrow(ZeroHexAsInteger.fromOrThrow(signature), message);
  return addressSchema.parse(VerifyingKey.getAddressOrThrow(key));
};

export interface AquaIntentAuthorization {
  readonly chainId: number;
  readonly controller: Address;
  readonly maker: Address;
  readonly commandHash: Hash;
  readonly nonce: Hash;
  readonly validBefore: bigint;
}

export const hashTypedAuthorization = (value: AquaIntentAuthorization): Hash => {
  initializeCubane();
  return keccakHex(hexToBytes(encodeAquaIntentPreimage(value)));
};

export const recoverTypedAuthorizationAddress = (value: AquaIntentAuthorization, signature: Hex): Address => {
  initializeCubane();
  const encoded = hexToBytes(encodeAquaIntentPreimage(value));
  const key = recoverUnprefixedMessageOrThrow(ZeroHexAsInteger.fromOrThrow(signature), encoded);
  return addressSchema.parse(VerifyingKey.getAddressOrThrow(key));
};

const recoverPreimage = (encoded: Hex, signature: Hex): Address => {
  initializeCubane();
  const key = recoverUnprefixedMessageOrThrow(ZeroHexAsInteger.fromOrThrow(signature), hexToBytes(encoded));
  return addressSchema.parse(VerifyingKey.getAddressOrThrow(key));
};

export const recoverAgentBindingAddress = (value: Parameters<typeof encodeAgentBindingPreimage>[0], signature: Hex): Address =>
  recoverPreimage(encodeAgentBindingPreimage(value), signature);

export const recoverTradeLifecycleAddress = (value: Parameters<typeof encodeTradeLifecyclePreimage>[0], signature: Hex): Address =>
  recoverPreimage(encodeTradeLifecyclePreimage(value), signature);

export const recoverDelegationAddress = (value: Parameters<typeof encodeDelegationPreimage>[0], signature: Hex): Address =>
  recoverPreimage(encodeDelegationPreimage(value), signature);
