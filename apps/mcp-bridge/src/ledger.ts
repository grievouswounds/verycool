import { addressSchema, hexSchema } from "@aqua/core/schemas";
import type { Address, Hex } from "@aqua/core/types";
import { z } from "zod";
import { ledgerAddress, ledgerSignMessage, ledgerSignTypedData } from "./ledger-runtime.mjs";

const signatureScalarSchema = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/u, "Expected a 1- to 32-byte hexadecimal signature scalar");
const signatureSchema = z.object({ r: signatureScalarSchema, s: signatureScalarSchema, v: z.number().int().min(0).max(255) }).strict();
const signedSchema = z.object({ owner: addressSchema, signature: signatureSchema }).strict();

export const joinLedgerSignature = (value: unknown): Hex => {
  const signature = signatureSchema.parse(value);
  const r = signature.r.slice(2).padStart(64, "0"); const s = signature.s.slice(2).padStart(64, "0");
  const recovery = signature.v < 27 ? signature.v + 27 : signature.v;
  return hexSchema.parse(`0x${r}${s}${recovery.toString(16).padStart(2, "0")}`);
};

export const ledgerOwnerAddress = async (): Promise<Address> => addressSchema.parse(await ledgerAddress());
export const signLedgerMessage = async (expectedOwner: Address, message: string): Promise<Hex> => {
  const result = signedSchema.parse(await ledgerSignMessage(message));
  if (result.owner !== expectedOwner) throw new Error("Connected Ledger account does not match the authenticated owner");
  return joinLedgerSignature(result.signature);
};
export const signLedgerTypedData = async (expectedOwner: Address, typedData: Readonly<Record<string, unknown>>): Promise<Hex> => {
  const result = signedSchema.parse(await ledgerSignTypedData(typedData));
  if (result.owner !== expectedOwner) throw new Error("Connected Ledger account does not match the authenticated owner");
  return joinLedgerSignature(result.signature);
};
