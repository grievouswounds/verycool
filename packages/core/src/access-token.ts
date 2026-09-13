import { parseStrictJson } from "./json.ts";
import { addressSchema } from "./schemas.ts";
import type { Address } from "./types.ts";
import { z } from "zod";

const SIGNATURE_LENGTH = 64;

export const accessTokenSubject = (token: string): Address => {
  const parts = token.split(".");
  if (parts.length < 3 || parts[0] !== "v4" || parts[1] !== "public" || parts[2] === undefined) {
    throw new Error("Access token is not a PASETO v4.public value");
  }
  const packed = Buffer.from(parts[2], "base64url");
  if (packed.length <= SIGNATURE_LENGTH) throw new Error("Access token payload is truncated");
  const message = packed.subarray(0, packed.length - SIGNATURE_LENGTH);
  const payload = z.object({ sub: addressSchema }).loose().parse(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(message)));
  return payload.sub;
};
