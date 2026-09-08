import { blake2b } from "@noble/hashes/blake2b";
import { AUTHENTICATION_SCOPES, addressSchema, parseStrictJson } from "@aqua/core";
import type { Address, AuthenticatedPrincipal, AuthenticationScope } from "@aqua/core";
import { parsePublicToken } from "paseto-ts/lib/parse";
import { sign, verify } from "paseto-ts/v4";
import { z } from "zod";

const MAX_ACCESS_TOKEN_LENGTH = 4_096;
const MAX_FOOTER_LENGTH = 256;
const publicKeyPattern = /^k4\.public\.[A-Za-z0-9_-]{43}$/u;
const secretKeyPattern = /^k4\.secret\.[A-Za-z0-9_-]{86}$/u;
const keyIdPattern = /^k4\.pid\.[A-Za-z0-9_-]{44}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

const footerSchema = z.object({ kid: z.string().regex(keyIdPattern) }).strict();
const accessTokenClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  sub: addressSchema,
  iat: z.iso.datetime({ offset: true }),
  exp: z.iso.datetime({ offset: true }),
  jti: z.uuid(),
  sid: z.uuid(),
  chain_id: z.number().int().positive(),
  scope: z.string().min(1).max(512),
  amr: z.array(z.enum(["siwe", "fido2", "hwk"])).min(1),
  client_id: z.string().min(1).max(256),
}).strict();
const authUriSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && url.hash === "";
});
const tokenConfigurationSchema = z.object({
  issuer: authUriSchema, resource: authUriSchema, chainId: z.number().int().positive(),
}).strict();
const trustConfiguration = (config: PasetoAccessTokenConfiguration): PasetoAccessTokenConfiguration =>
  tokenConfigurationSchema.parse({ issuer: config.issuer, resource: config.resource, chainId: config.chainId });

export interface PasetoAccessTokenConfiguration {
  readonly issuer: string;
  readonly resource: string;
  readonly chainId: number;
}

export interface PasetoAccessTokenIssuerConfiguration extends PasetoAccessTokenConfiguration {
  readonly secretKeyPaserk: string;
  readonly publicKeysPaserk: readonly string[];
  readonly ttlSeconds: number;
  readonly now?: () => Date;
}

export interface PasetoAccessTokenVerifierConfiguration extends PasetoAccessTokenConfiguration {
  readonly publicKeysPaserk: readonly string[];
}

export interface AccessTokenGrant {
  readonly address: Address;
  readonly sessionId: string;
  readonly scopes: readonly AuthenticationScope[];
  readonly amr?: readonly ("siwe" | "fido2" | "hwk")[];
  readonly clientId?: string;
}

const paserkPublicId = (publicKey: string): string => {
  if (!publicKeyPattern.test(publicKey)) throw new Error("Invalid PASETO v4.public PASERK");
  const input = new TextEncoder().encode(`k4.pid.${publicKey}`);
  return `k4.pid.${Buffer.from(blake2b(input, { dkLen: 33 })).toString("base64url")}`;
};

const publicKeyring = (publicKeys: readonly string[]): ReadonlyMap<string, string> => {
  if (publicKeys.length === 0) throw new Error("At least one PASETO public key is required");
  const uniqueKeys = new Set(publicKeys);
  if (uniqueKeys.size !== publicKeys.length) throw new Error("Duplicate PASETO public key");
  const entries = publicKeys.map((key) => [paserkPublicId(key), key] as const);
  const ring = new Map(entries);
  if (ring.size !== entries.length) throw new Error("Duplicate PASETO public key identifier");
  return ring;
};

const decodeFooter = (token: string): z.infer<typeof footerSchema> => {
  if (token.length === 0 || token.length > MAX_ACCESS_TOKEN_LENGTH) throw new Error("Invalid PASETO token length");
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v4" || parts[1] !== "public") throw new Error("Invalid PASETO token format");
  const encodedFooter = parts[3];
  if (encodedFooter === undefined || encodedFooter.length === 0 || encodedFooter.length > MAX_FOOTER_LENGTH || !base64UrlPattern.test(encodedFooter)) {
    throw new Error("Invalid PASETO footer");
  }
  const bytes = Buffer.from(encodedFooter, "base64url");
  if (bytes.toString("base64url") !== encodedFooter) throw new Error("Non-canonical PASETO footer");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let parsed: unknown;
  try { parsed = parseStrictJson(text); }
  catch { throw new Error("Invalid PASETO footer JSON"); }
  return footerSchema.parse(parsed);
};

const scopesFromClaim = (claim: string): ReadonlySet<AuthenticationScope> => {
  if (!/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/u.test(claim)) throw new Error("Invalid OAuth scope claim");
  const values = claim.split(" ");
  if (new Set(values).size !== values.length) throw new Error("Duplicate OAuth scope");
  const known = new Set<string>(AUTHENTICATION_SCOPES);
  if (!values.every((value) => known.has(value))) throw new Error("Unsupported OAuth scope");
  return new Set(values.filter((value): value is AuthenticationScope => known.has(value)));
};

export class PasetoAccessTokenVerifier {
  private readonly config: PasetoAccessTokenConfiguration;
  private readonly keys: ReadonlyMap<string, string>;

  public constructor(config: PasetoAccessTokenVerifierConfiguration) {
    this.config = trustConfiguration(config);
    this.keys = publicKeyring(config.publicKeysPaserk);
  }

  public authenticate(token: string): AuthenticatedPrincipal {
    const untrustedFooter = decodeFooter(token);
    const publicKey = this.keys.get(untrustedFooter.kid);
    if (publicKey === undefined) throw new Error("Unknown PASETO key identifier");
    verify(publicKey, token);
    const { message } = parsePublicToken(token);
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(message);
    const payload = accessTokenClaimsSchema.parse(parseStrictJson(payloadText));
    if (payload.iss !== this.config.issuer) throw new Error("Unexpected PASETO issuer");
    if (payload.aud !== this.config.resource) throw new Error("Unexpected PASETO audience");
    if (payload.chain_id !== this.config.chainId) throw new Error("Unexpected PASETO chain");
    return {
      address: payload.sub,
      sessionId: payload.sid,
      scopes: scopesFromClaim(payload.scope),
      authenticationMethods: new Set(payload.amr),
      clientId: payload.client_id,
    };
  }
}

export class PasetoAccessTokenIssuer {
  private readonly config: PasetoAccessTokenIssuerConfiguration;
  private readonly activeKeyId: string;
  private readonly now: () => Date;

  public constructor(config: PasetoAccessTokenIssuerConfiguration) {
    trustConfiguration(config);
    if (!secretKeyPattern.test(config.secretKeyPaserk)) throw new Error("Invalid PASETO v4.secret PASERK");
    if (!Number.isInteger(config.ttlSeconds) || config.ttlSeconds < 1) throw new Error("Invalid PASETO access-token TTL");
    const keys = publicKeyring(config.publicKeysPaserk);
    const probe = sign(config.secretKeyPaserk, { probe: crypto.randomUUID() }, { addIat: false, addExp: false, validatePayload: false });
    const matching = Array.from(keys.entries()).filter(([, publicKey]) => {
      try { verify(publicKey, probe, { validatePayload: false }); return true; }
      catch { return false; }
    });
    if (matching.length !== 1 || matching[0] === undefined) throw new Error("PASETO secret key must match exactly one configured public key");
    this.config = config;
    this.activeKeyId = matching[0][0];
    this.now = config.now ?? (() => new Date());
  }

  public issue(grant: AccessTokenGrant): string {
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.config.ttlSeconds * 1_000);
    const scopes = AUTHENTICATION_SCOPES.filter((scope) => grant.scopes.includes(scope));
    if (scopes.length === 0 || scopes.length !== grant.scopes.length || new Set(grant.scopes).size !== grant.scopes.length) {
      throw new Error("Invalid access-token scope grant");
    }
    const subject = addressSchema.parse(grant.address);
    const sessionId = z.uuid().parse(grant.sessionId);
    return sign(this.config.secretKeyPaserk, {
      iss: this.config.issuer,
      aud: this.config.resource,
      sub: subject,
      iat: issuedAt.toISOString(),
      exp: expiresAt.toISOString(),
      jti: crypto.randomUUID(),
      sid: sessionId,
      chain_id: this.config.chainId,
      scope: scopes.join(" "),
      amr: grant.amr ?? ["siwe"],
      client_id: grant.clientId ?? "aqua-rest",
    }, { footer: { kid: this.activeKeyId }, addIat: false, addExp: false });
  }
}
