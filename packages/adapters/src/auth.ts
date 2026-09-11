import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { AppError, AUTHENTICATION_SCOPES } from "@aqua/core";
import type { Address, AuthenticatedPrincipal, Hex, RpcPort } from "@aqua/core";
import { encodeIsValidSignature, hasContractCode, keccakHex, recoverPersonalAddress } from "@aqua/evm";
import { PasetoAccessTokenIssuer, PasetoAccessTokenVerifier } from "./paseto.ts";
import type { AccessTokenGrant } from "./paseto.ts";

interface ChallengeDocument { readonly _id: string; readonly address: Address; readonly message: string; readonly expiresAt: Date; readonly usedAt?: Date }
interface RefreshDocument { readonly _id: string; readonly address: Address; readonly sessionId: string; readonly expiresAt: Date; readonly usedAt?: Date }
export interface AuthStore { saveChallenge(challenge: ChallengeDocument): Promise<void>; consumeChallenge(id: string, now: Date): Promise<ChallengeDocument | null>; saveRefresh(refresh: RefreshDocument): Promise<void>; consumeRefresh(hash: string, now: Date): Promise<RefreshDocument | null> }
interface ChallengeRow { readonly id: string; readonly address: Address; readonly message: string; readonly expires_at: Date; readonly used_at: Date | null }
interface RefreshRow { readonly id: string; readonly address: Address; readonly session_id: string; readonly expires_at: Date; readonly used_at: Date | null }
export class PostgresAuthStore implements AuthStore {
  private readonly database: SQL;
  public constructor(database: SQL) { this.database = database; }
  public async initialize(): Promise<void> { await this.database`DELETE FROM auth_challenges WHERE expires_at <= now()`; await this.database`DELETE FROM auth_refresh_tokens WHERE expires_at <= now()`; }
  public async saveChallenge(value: ChallengeDocument): Promise<void> { await this.database`DELETE FROM auth_challenges WHERE expires_at <= now()`; await this.database`INSERT INTO auth_challenges (id,address,message,expires_at) VALUES (${value._id},${value.address},${value.message},${value.expiresAt})`; }
  public async consumeChallenge(id: string, now: Date): Promise<ChallengeDocument | null> { const rows = await this.database<ChallengeRow[]>`UPDATE auth_challenges SET used_at=${now} WHERE id=${id} AND used_at IS NULL AND expires_at>${now} RETURNING id,address,message,expires_at,used_at`; const row = rows[0]; return row === undefined ? null : { _id: row.id, address: row.address, message: row.message, expiresAt: row.expires_at, ...(row.used_at === null ? {} : { usedAt: row.used_at }) }; }
  public async saveRefresh(value: RefreshDocument): Promise<void> { await this.database`DELETE FROM auth_refresh_tokens WHERE expires_at <= now()`; await this.database`INSERT INTO auth_refresh_tokens (id,address,session_id,expires_at) VALUES (${value._id},${value.address},${value.sessionId},${value.expiresAt})`; }
  public async consumeRefresh(id: string, now: Date): Promise<RefreshDocument | null> { const rows = await this.database<RefreshRow[]>`UPDATE auth_refresh_tokens SET used_at=${now} WHERE id=${id} AND used_at IS NULL AND expires_at>${now} RETURNING id,address,session_id,expires_at,used_at`; const row = rows[0]; return row === undefined ? null : { _id: row.id, address: row.address, sessionId: row.session_id, expiresAt: row.expires_at, ...(row.used_at === null ? {} : { usedAt: row.used_at }) }; }
}
export interface AuthConfiguration { readonly domain: string; readonly uri: string; readonly chainId: number; readonly issuer: string; readonly resource: string; readonly secretKeyPaserk: string; readonly publicKeysPaserk: readonly string[]; readonly accessTtlSeconds: number; readonly refreshTtlSeconds: number }
export interface SessionResult { readonly accessToken: string; readonly expiresIn: number; readonly refreshToken: string }
export interface AccessTokenIssuer { issue(grant: AccessTokenGrant): string | Promise<string> }
const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
export class AuthService {
  private readonly config: AuthConfiguration; private readonly store: AuthStore; private readonly tokenIssuer: AccessTokenIssuer; private readonly tokenVerifier: PasetoAccessTokenVerifier; private readonly rpc: RpcPort;
  private constructor(config: AuthConfiguration, store: AuthStore, tokenIssuer: AccessTokenIssuer, tokenVerifier: PasetoAccessTokenVerifier, rpc: RpcPort) { this.config=config; this.store=store; this.tokenIssuer=tokenIssuer; this.tokenVerifier=tokenVerifier; this.rpc=rpc; }
  public static async create(config: AuthConfiguration, store: AuthStore, rpc: RpcPort): Promise<AuthService> { const tokenConfiguration = { issuer: config.issuer, resource: config.resource, chainId: config.chainId, publicKeysPaserk: config.publicKeysPaserk }; return new AuthService(config, store, new PasetoAccessTokenIssuer({ ...tokenConfiguration, secretKeyPaserk: config.secretKeyPaserk, ttlSeconds: config.accessTtlSeconds }), new PasetoAccessTokenVerifier(tokenConfiguration), rpc); }
  public static withIssuer(config: AuthConfiguration, store: AuthStore, rpc: RpcPort, issuer: AccessTokenIssuer): AuthService { const tokenConfiguration={issuer:config.issuer,resource:config.resource,chainId:config.chainId,publicKeysPaserk:config.publicKeysPaserk}; return new AuthService(config,store,issuer,new PasetoAccessTokenVerifier(tokenConfiguration),rpc); }
  public async challenge(address: Address): Promise<{ readonly challengeId: string; readonly message: string; readonly expiresAt: string }> { const now = new Date(); const expiresAt = new Date(now.getTime() + 300_000); const challengeId = randomUUID(); const nonce = randomBytes(12).toString("base64url"); const message = `${this.config.domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Aqua Backend\n\nURI: ${this.config.uri}\nVersion: 1\nChain ID: ${String(this.config.chainId)}\nNonce: ${nonce}\nIssued At: ${now.toISOString()}\nExpiration Time: ${expiresAt.toISOString()}\nRequest ID: ${challengeId}`; await this.store.saveChallenge({ _id: challengeId, address, message, expiresAt }); return { challengeId, message, expiresAt: expiresAt.toISOString() }; }
  public async session(challengeId: string, message: string, signature: Hex): Promise<SessionResult> {
    const challenge = await this.store.consumeChallenge(challengeId, new Date());
    if (challenge?.message !== message) throw new AppError(409, "urn:aqua:error:challenge", "Challenge is invalid, expired, or already used");
    try {
      if (recoverPersonalAddress(message, signature) === challenge.address) {
        return await this.issue(challenge.address, randomUUID());
      }
    } catch { /* contract wallets are verified with EIP-1271 below */ }
    const code = await this.rpc.getCode(challenge.address);
    if (!hasContractCode(code)) throw new AppError(401, "urn:aqua:error:signature", "Signature does not match the requested account");
    const bytes = new TextEncoder().encode(message);
    const prefix = new TextEncoder().encode(`\u0019Ethereum Signed Message:\n${String(bytes.length)}`);
    let result: string;
    try {
      result = await this.rpc.call({ to: challenge.address, data: encodeIsValidSignature(keccakHex(Uint8Array.from([...prefix, ...bytes])), signature) });
    } catch {
      throw new AppError(401, "urn:aqua:error:signature", "EIP-1271 signature was rejected");
    }
    if (!result.toLowerCase().startsWith("0x1626ba7e")) throw new AppError(401, "urn:aqua:error:signature", "EIP-1271 signature was rejected");
    return this.issue(challenge.address, randomUUID());
  }
  public async refresh(token: string): Promise<SessionResult> { const stored = await this.store.consumeRefresh(tokenHash(token), new Date()); if (stored === null) throw new AppError(401, "urn:aqua:error:refresh", "Refresh token is invalid, expired, or already used"); return this.issue(stored.address, stored.sessionId); }
  public issueHardware(address: Address, clientId: string, scopes: readonly (typeof AUTHENTICATION_SCOPES)[number][]): Promise<SessionResult> { return this.issue(address, randomUUID(), ["fido2","hwk"], clientId, scopes); }
  private async issue(address: Address, sessionId: string, amr:readonly ("siwe"|"fido2"|"hwk")[]=["siwe"], clientId="aqua-rest", scopes:readonly (typeof AUTHENTICATION_SCOPES)[number][]=AUTHENTICATION_SCOPES): Promise<SessionResult> { const refreshToken = randomBytes(32).toString("base64url"); await this.store.saveRefresh({ _id: tokenHash(refreshToken), address, sessionId, expiresAt: new Date(Date.now() + this.config.refreshTtlSeconds * 1_000) }); return { accessToken: await this.tokenIssuer.issue({ address, sessionId, scopes, amr, clientId }), refreshToken, expiresIn: this.config.accessTtlSeconds }; }
  public async authenticate(token: string): Promise<AuthenticatedPrincipal> { try { return this.tokenVerifier.authenticate(token); } catch { throw new AppError(401, "urn:aqua:error:authentication", "Invalid or expired access token", { bearerError: "invalid_token" }); } }
}
