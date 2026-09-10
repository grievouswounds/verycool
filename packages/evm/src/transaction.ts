import { ZeroHexSigner } from "@hazae41/cubane";
import { addressSchema, hexSchema } from "@aqua/core";
import type { Address, Hex } from "@aqua/core";
import { initializeCubane } from "./crypto.ts";
import { bytesToHex, concatHex, hexToBytes } from "./hex.ts";

export interface Eip1559Transaction {
  readonly chainId: bigint; readonly nonce: bigint; readonly maxPriorityFeePerGas: bigint; readonly maxFeePerGas: bigint;
  readonly gas: bigint; readonly to: Address; readonly value: bigint; readonly data: Hex;
}

const bytesToInteger = (value: Uint8Array): bigint => (value.length === 0 ? 0n : BigInt(bytesToHex(value)));
const integerBytes = (value: bigint): Uint8Array => {
  if (value < 0n) throw new Error("Transaction integer cannot be negative");
  if (value === 0n) return new Uint8Array();
  const raw = value.toString(16); return hexToBytes(hexSchema.parse(`0x${raw.length % 2 === 0 ? raw : `0${raw}`}`));
};
const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
};
const rlpPrefix = (shortBase: number, longBase: number, payload: Uint8Array): Uint8Array => {
  if (payload.length <= 55) return concatBytes([Uint8Array.of(shortBase + payload.length), payload]);
  const length = integerBytes(BigInt(payload.length));
  return concatBytes([Uint8Array.of(longBase + length.length), length, payload]);
};
const rlpString = (bytes: Uint8Array): Uint8Array => {
  const first = bytes[0];
  if (bytes.length === 1 && first !== undefined && first < 0x80) return bytes;
  return rlpPrefix(0x80, 0xb7, bytes);
};
const rlpList = (items: readonly Uint8Array[]): Uint8Array => rlpPrefix(0xc0, 0xf7, concatBytes(items));
const encodeRlp = (values: readonly (Uint8Array | readonly Uint8Array[])[]): Hex =>
  bytesToHex(rlpList(values.map((value) => value instanceof Uint8Array ? rlpString(value) : rlpList(value.map(rlpString)))));
const unsignedFields = (transaction: Eip1559Transaction): readonly (Uint8Array | readonly Uint8Array[])[] => [
  integerBytes(transaction.chainId), integerBytes(transaction.nonce), integerBytes(transaction.maxPriorityFeePerGas),
  integerBytes(transaction.maxFeePerGas), integerBytes(transaction.gas), hexToBytes(transaction.to), integerBytes(transaction.value),
  hexToBytes(transaction.data), [],
];

export class CubaneTransactionSigner {
  private readonly signer: ZeroHexSigner;
  public readonly address: Address;

  public constructor(privateKey: Hex) {
    initializeCubane();
    if (privateKey.length !== 66) throw new Error("Keeper private key must contain exactly 32 bytes");
    this.signer = ZeroHexSigner.fromOrThrow(privateKey);
    this.address = addressSchema.parse(this.signer.address.toString());
  }

  public sign(transaction: Eip1559Transaction): Hex {
    const fields = unsignedFields(transaction);
    const preimage = concatHex(hexSchema.parse("0x02"), encodeRlp(fields));
    const signature = this.signer.signUnprefixedMessageOrThrow(hexToBytes(preimage));
    const signed = encodeRlp([
      ...fields,
      integerBytes(BigInt(signature.v - 27)),
      integerBytes(bytesToInteger(new Uint8Array(signature.r))),
      integerBytes(bytesToInteger(new Uint8Array(signature.s))),
    ]);
    return concatHex(hexSchema.parse("0x02"), signed);
  }
}
