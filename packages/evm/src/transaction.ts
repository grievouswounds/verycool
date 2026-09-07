import { Rlp, ZeroHexSigner } from "@hazae41/cubane";
import { Cursor } from "@hazae41/cursor";
import { addressSchema, hexSchema } from "@aqua/core";
import type { Address, Hex } from "@aqua/core";
import { bytesToHex, concatHex, hexToBytes } from "./hex.ts";

export interface Eip1559Transaction {
  readonly chainId: bigint; readonly nonce: bigint; readonly maxPriorityFeePerGas: bigint; readonly maxFeePerGas: bigint;
  readonly gas: bigint; readonly to: Address; readonly value: bigint; readonly data: Hex;
}

const integerBytes = (value: bigint): Uint8Array => {
  if (value < 0n) throw new Error("Transaction integer cannot be negative");
  if (value === 0n) return new Uint8Array();
  const raw = value.toString(16); return hexToBytes(hexSchema.parse(`0x${raw.length % 2 === 0 ? raw : `0${raw}`}`));
};
type RlpInput = Uint8Array | RlpInput[];
const encodeRlp = (values: readonly (Uint8Array | readonly Uint8Array[])[]): Hex => {
  const normalized: RlpInput[] = values.map((value) => value instanceof Uint8Array ? value : Array.from(value));
  const encoded = Rlp.fromOrThrow(normalized);
  const output = new Uint8Array(encoded.sizeOrThrow());
  encoded.writeOrThrow(new Cursor(output));
  return bytesToHex(output);
};
const unsignedFields = (transaction: Eip1559Transaction): readonly (Uint8Array | readonly Uint8Array[])[] => [
  integerBytes(transaction.chainId), integerBytes(transaction.nonce), integerBytes(transaction.maxPriorityFeePerGas),
  integerBytes(transaction.maxFeePerGas), integerBytes(transaction.gas), hexToBytes(transaction.to), integerBytes(transaction.value),
  hexToBytes(transaction.data), [],
];

export class CubaneTransactionSigner {
  private readonly signer: ZeroHexSigner;
  public readonly address: Address;

  public constructor(privateKey: Hex) {
    if (privateKey.length !== 66) throw new Error("Keeper private key must contain exactly 32 bytes");
    this.signer = ZeroHexSigner.fromOrThrow(privateKey);
    this.address = addressSchema.parse(this.signer.address.toString());
  }

  public sign(transaction: Eip1559Transaction): Hex {
    const fields = unsignedFields(transaction);
    const preimage = concatHex(hexSchema.parse("0x02"), encodeRlp(fields));
    const signature = this.signer.signUnprefixedMessageOrThrow(hexToBytes(preimage));
    const signed = encodeRlp([...fields, integerBytes(BigInt(signature.v - 27)), signature.r, signature.s]);
    return concatHex(hexSchema.parse("0x02"), signed);
  }
}
