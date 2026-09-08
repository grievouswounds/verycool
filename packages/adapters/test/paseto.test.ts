import { describe, expect, test } from "bun:test";
import { addressSchema, AUTHENTICATION_SCOPES } from "@aqua/core";
import { generateKeys, sign, verify } from "paseto-ts/v4";
import { z } from "zod";
import { PasetoAccessTokenIssuer, PasetoAccessTokenVerifier } from "../src/paseto.ts";

const address = addressSchema.parse("0x1111111111111111111111111111111111111111");
const sessionId = "00000000-0000-4000-8000-000000000001";
const issuer = "https://auth.example.com";
const resource = "https://api.example.com/mcp";
const footerSchema = z.object({ kid: z.string() }).strict();
const envelopeSchema = z.object({ payload: z.record(z.string(), z.unknown()), footer: footerSchema }).strict();

const footerOf = (token: string): { readonly kid: string } => {
  const encoded = token.split(".")[3];
  if (encoded === undefined) throw new Error("Token footer is missing");
  return footerSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown);
};

const createPair = () => generateKeys("public");
const issuerFor = (secretKey: string, publicKeys: readonly string[], now: Date = new Date()) =>
  new PasetoAccessTokenIssuer({
    issuer, resource, chainId: 1, secretKeyPaserk: secretKey, publicKeysPaserk: publicKeys,
    ttlSeconds: 900, now: () => now,
  });
const verifierFor = (publicKeys: readonly string[], overrides: Partial<{ readonly issuer: string; readonly resource: string; readonly chainId: number }> = {}) =>
  new PasetoAccessTokenVerifier({ issuer, resource, chainId: 1, publicKeysPaserk: publicKeys, ...overrides });

describe("PASETO access tokens", () => {
  test("issues a strict, resource-bound v4.public token", () => {
    const pair = createPair();
    const now = new Date();
    const token = issuerFor(pair.secretKey, [pair.publicKey], now).issue({ address, sessionId, scopes: AUTHENTICATION_SCOPES });
    expect(token.startsWith("v4.public.")).toBeTrue();
    const result: unknown = verify(pair.publicKey, token);
    const envelope = envelopeSchema.parse(result);
    expect(envelope.payload).toMatchObject({
      iss: issuer, aud: resource, sub: address, iat: now.toISOString(), sid: sessionId,
      chain_id: 1, scope: AUTHENTICATION_SCOPES.join(" "),
    });
    expect(envelope.footer.kid.startsWith("k4.pid.")).toBeTrue();
    expect(verifierFor([pair.publicKey]).authenticate(token)).toEqual({
      address, sessionId, scopes: new Set(AUTHENTICATION_SCOPES),
      authenticationMethods: new Set(["siwe"]), clientId: "aqua-rest",
    });
  });

  test("accepts retiring keys and uses the active key identifier for new tokens", () => {
    const oldPair = createPair();
    const newPair = createPair();
    const publicKeys = [oldPair.publicKey, newPair.publicKey];
    const oldToken = issuerFor(oldPair.secretKey, publicKeys).issue({ address, sessionId, scopes: ["trading:read"] });
    const newToken = issuerFor(newPair.secretKey, publicKeys).issue({ address, sessionId, scopes: ["trading:write"] });
    const verifier = verifierFor(publicKeys);
    expect(footerOf(oldToken).kid).not.toBe(footerOf(newToken).kid);
    expect(verifier.authenticate(oldToken).scopes).toEqual(new Set(["trading:read"]));
    expect(verifier.authenticate(newToken).scopes).toEqual(new Set(["trading:write"]));
  });

  test("rejects wrong trust context, tampering, JWTs, unknown keys, and oversized tokens", () => {
    const pair = createPair();
    const token = issuerFor(pair.secretKey, [pair.publicKey]).issue({ address, sessionId, scopes: ["activity:read"] });
    expect(() => verifierFor([pair.publicKey], { issuer: "https://other.example.com" }).authenticate(token)).toThrow();
    expect(() => verifierFor([pair.publicKey], { resource: "https://other.example.com" }).authenticate(token)).toThrow();
    expect(() => verifierFor([pair.publicKey], { chainId: 2 }).authenticate(token)).toThrow();
    expect(() => verifierFor([pair.publicKey]).authenticate(`${token.slice(0, -1)}A`)).toThrow();
    expect(() => verifierFor([pair.publicKey]).authenticate("eyJhbGciOiJFZERTQSJ9.e30.signature")).toThrow();
    const malformedFooter = `${token.split(".").slice(0, 3).join(".")}.${Buffer.from("not-json").toString("base64url")}`;
    expect(() => verifierFor([pair.publicKey]).authenticate(malformedFooter)).toThrow();
    const unknownKeyToken = sign(pair.secretKey, {
      iss: issuer, aud: resource, sub: address, iat: new Date().toISOString(),
      exp: new Date(Date.now() + 60_000).toISOString(), jti: crypto.randomUUID(),
      sid: sessionId, chain_id: 1, scope: "activity:read",
    }, { footer: { kid: `k4.pid.${"A".repeat(44)}` }, addIat: false, addExp: false });
    expect(() => verifierFor([pair.publicKey]).authenticate(unknownKeyToken)).toThrow();
    expect(() => verifierFor([pair.publicKey]).authenticate(`${token}${"A".repeat(4_096)}`)).toThrow();
  });

  test("rejects malformed or expired application claims", () => {
    const pair = createPair();
    const valid = issuerFor(pair.secretKey, [pair.publicKey]).issue({ address, sessionId, scopes: ["activity:read"] });
    const footer = footerOf(valid);
    const malformed = sign(pair.secretKey, {
      iss: issuer, aud: resource, sub: address, iat: new Date().toISOString(),
      exp: new Date(Date.now() + 60_000).toISOString(), jti: crypto.randomUUID(),
      sid: "not-a-uuid", chain_id: 1, scope: "activity:read",
    }, { footer, addIat: false, addExp: false });
    const expired = sign(pair.secretKey, {
      iss: issuer, aud: resource, sub: address, iat: "2020-01-01T00:00:00.000Z",
      exp: "2020-01-01T00:01:00.000Z", jti: crypto.randomUUID(),
      sid: sessionId, chain_id: 1, scope: "activity:read",
    }, { footer, addIat: false, addExp: false, validatePayload: false });
    expect(() => verifierFor([pair.publicKey]).authenticate(malformed)).toThrow();
    expect(() => verifierFor([pair.publicKey]).authenticate(expired)).toThrow();
  });

  test("rejects malformed keyrings and a mismatched signing key", () => {
    const first = createPair();
    const second = createPair();
    expect(() => verifierFor([])).toThrow();
    expect(() => verifierFor([first.publicKey, first.publicKey])).toThrow();
    expect(() => issuerFor(first.secretKey, [second.publicKey])).toThrow();
  });
});
