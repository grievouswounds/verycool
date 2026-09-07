import type { Address, Hex } from "@aqua/core";
import { bytesToHex, hexToBytes } from "@aqua/evm";

export const AQUA_MAKER_TRAITS = 1n << 254n;

const uintToBytes = (value: bigint, length: number): Uint8Array => {
  const result = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new Error(`Value exceeds ${String(length)} bytes`);
  return result;
};

export interface TakerTraitsInput {
  readonly exactIn: boolean;
  readonly shouldUnwrap: boolean;
  readonly threshold: bigint;
  readonly taker: Address;
  readonly recipient?: Address;
  readonly deadlineSeconds: bigint;
}

export const encodeTakerTraits = (input: TakerTraitsInput): Hex => {
  const threshold = input.threshold > 0n ? uintToBytes(input.threshold, 32) : new Uint8Array();
  const recipient = input.recipient !== undefined && input.recipient !== input.taker
    ? hexToBytes(input.recipient)
    : new Uint8Array();
  const deadline = input.deadlineSeconds > 0n ? uintToBytes(input.deadlineSeconds, 5) : new Uint8Array();
  const fields: readonly Uint8Array[] = [
    threshold, recipient, deadline,
    new Uint8Array(), new Uint8Array(), new Uint8Array(), new Uint8Array(),
    new Uint8Array(), new Uint8Array(), new Uint8Array(),
  ];
  const offsets: number[] = [];
  let offset = 0;
  for (const field of fields) {
    offset += field.length;
    offsets.push(offset);
  }
  let flags = 1 << 6;
  if (input.exactIn) flags |= 1;
  if (input.shouldUnwrap) flags |= 1 << 1;
  // Reverse uint16 fields, not their individual bytes.
  const orderedOffsets = Uint8Array.from(offsets.toReversed().flatMap((value) => [...uintToBytes(BigInt(value), 2)]));
  return bytesToHex(Uint8Array.from([
    ...orderedOffsets, ...uintToBytes(BigInt(flags), 2), ...fields.flatMap((field) => [...field]),
  ]));
};
