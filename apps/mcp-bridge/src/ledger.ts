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
const jsonable = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  if (Array.isArray(value)) return value.map(jsonable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonable(item)]));
  return value;
};
const scalarHex = (item: unknown): string | undefined => {
  if (typeof item === "string") return item;
  if (typeof item === "bigint") return `0x${item.toString(16)}`;
  if (item instanceof Uint8Array) return `0x${Buffer.from(item).toString("hex")}`;
  return undefined;
};
const asSignature = (value: unknown): unknown => {
  const parsed = z.object({
    owner: z.unknown(),
    signature: z.object({ r: z.unknown(), s: z.unknown(), v: z.unknown() }).loose(),
  }).loose().safeParse(value);
  if (!parsed.success) return jsonable(value);
  const v = parsed.data.signature.v;
  return {
    owner: parsed.data.owner,
    signature: {
      r: scalarHex(parsed.data.signature.r),
      s: scalarHex(parsed.data.signature.s),
      v: typeof v === "bigint" ? Number(v) : v,
    },
  };
};
export const signLedgerTypedData = async (expectedOwner: Address, typedData: Readonly<Record<string, unknown>>): Promise<Hex> => {
  const raw = await ledgerSignTypedData(typedData);
  const parsed = signedSchema.safeParse(asSignature(raw));
  if (!parsed.success) throw new Error(`Ledger typed-data signature is malformed: ${JSON.stringify(jsonable(raw))}`);
  if (parsed.data.owner !== expectedOwner) throw new Error("Connected Ledger account does not match the authenticated owner");
  return joinLedgerSignature(parsed.data.signature);
};
