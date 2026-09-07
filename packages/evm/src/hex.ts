import { keccak256 } from "@hazae41/keccak256";
import { hashSchema, hexSchema, quantitySchema } from "@aqua/core";
import type { Address, Hash, Hex, Quantity } from "@aqua/core";

export const hexToBytes = (hex: Hex): Uint8Array => {
  const raw = hex.slice(2);
  if (raw.length % 2 !== 0) throw new Error("Hex data must have an even number of digits");
  const bytes = new Uint8Array(raw.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = raw.slice(index * 2, index * 2 + 2);
    const value = Number.parseInt(pair, 16);
    if (!Number.isFinite(value)) throw new Error("Invalid hexadecimal data");
    bytes[index] = value;
  }
  return bytes;
};

export const bytesToHex = (bytes: Uint8Array): Hex => {
  let value = "0x";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return hexSchema.parse(value);
};

export const concatHex = (...values: readonly Hex[]): Hex =>
  hexSchema.parse(`0x${values.map((value) => value.slice(2)).join("")}`);

export const keccakHex = (bytes: Uint8Array): Hash => hashSchema.parse(bytesToHex(keccak256.digest(bytes)));
export const selector = (signature: string): Hex => bytesToHex(keccak256.digest(new TextEncoder().encode(signature)).slice(0, 4));
export const addressToBigInt = (address: Address): bigint => BigInt(address);
export const quantityToHex = (value: bigint): Quantity => {
  if (value < 0n) throw new Error("RPC quantities cannot be negative");
  return zQuantity(value);
};
export const hexToQuantity = (value: string): bigint => BigInt(value);

const zQuantity = (value: bigint): Quantity => quantitySchema.parse(`0x${value.toString(16)}`);
