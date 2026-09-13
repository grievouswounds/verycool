import { describe, expect, test } from "bun:test";
import { accessTokenSubject } from "../src/access-token.ts";

const owner = "0xffcc5b18b67ea4b402d71d62d969d9ab626a64d8";

const tokenFromPayload = (payload: string): string => {
  const message = new TextEncoder().encode(payload);
  const packed = Buffer.concat([Buffer.from(message), Buffer.alloc(64)]);
  return `v4.public.${packed.toString("base64url")}`;
};

describe("accessTokenSubject", () => {
  test("reads the logged-in owner from a v4.public token", () => {
    expect(accessTokenSubject(tokenFromPayload(JSON.stringify({ sub: owner })))).toBe(owner);
  });

  test("rejects a token that is not v4.public", () => {
    expect(() => accessTokenSubject("v4.local.abc")).toThrow(/Access token/);
  });
});
