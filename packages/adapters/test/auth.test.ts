import { describe, expect, test } from "bun:test";
import { addressSchema, hashSchema, hexSchema } from "@aqua/core";
import type { Address, Hex, RpcBlock, RpcLog } from "@aqua/core";
import { initializeCubane, signPersonalMessage, signingKeyAddress } from "@aqua/evm";
import { generateKeys } from "paseto-ts/v4";
import { AuthService } from "../src/auth.ts";
import type { AuthStore } from "../src/auth.ts";

interface ChallengeRecord {
  readonly _id: string;
  readonly address: Address;
  readonly message: string;
  readonly expiresAt: Date;
  readonly usedAt?: Date;
}

interface RefreshRecord {
  readonly _id: string;
  readonly address: Address;
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly usedAt?: Date;
}

class MemoryAuthStore implements AuthStore {
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly refreshes = new Map<string, RefreshRecord>();
  public async saveChallenge(challenge: ChallengeRecord) { this.challenges.set(challenge._id, challenge); }
  public async consumeChallenge(id: string, now: Date) {
    const challenge = this.challenges.get(id);
    if (challenge === undefined || challenge.usedAt !== undefined || challenge.expiresAt <= now) return null;
    this.challenges.set(id, { ...challenge, usedAt: now });
    return challenge;
  }
  public async saveRefresh(refresh: RefreshRecord) { this.refreshes.set(refresh._id, refresh); }
  public async consumeRefresh(hash: string, now: Date) {
    const refresh = this.refreshes.get(hash);
    if (refresh === undefined || refresh.usedAt !== undefined || refresh.expiresAt <= now) return null;
    this.refreshes.set(hash, { ...refresh, usedAt: now });
    return refresh;
  }
}

class ContractWalletRpc {
  public async chainId() { return 1; }
  public async getCode() { return hexSchema.parse("0x01"); }
  public async call() { return hexSchema.parse("0x1626ba7e"); }
  public async estimateGas() { return 1n; }
  public async tokenDecimals() { return 18; }
  public async tokenSymbol() { return null; }
  public async blockNumber() { return 1n; }
  public async block(): Promise<RpcBlock> {
    return { number: 1n, hash: hashSchema.parse(`0x${"11".repeat(32)}`), timestamp: 1n };
  }
  public async logs(): Promise<readonly RpcLog[]> { return []; }
  public async transactionCount() { return 0n; }
  public async gasPrice() { return 1n; }
  public async maxPriorityFeePerGas() { return 1n; }
  public async sendRawTransaction() { return hashSchema.parse(`0x${"11".repeat(32)}`); }
  public async transactionReceipt() { return null; }
}

describe("PASETO-backed SIWE sessions", () => {
  test("creates a session and rotates its opaque refresh token", async () => {
    const pair = generateKeys("public");
    const store = new MemoryAuthStore();
    const auth = await AuthService.create({
      domain: "localhost", uri: "http://localhost:3000", chainId: 1,
      issuer: "https://auth.example.com", resource: "https://api.example.com/mcp",
      secretKeyPaserk: pair.secretKey, publicKeysPaserk: [pair.publicKey],
      accessTtlSeconds: 900, refreshTtlSeconds: 3_600,
    }, store, new ContractWalletRpc());
    const wallet = addressSchema.parse("0x1111111111111111111111111111111111111111");
    const challenge = await auth.challenge(wallet);
    const signature = hexSchema.parse(`0x${"11".repeat(65)}`);
    const session = await auth.session(challenge.challengeId, challenge.message, signature);
    expect(session.accessToken.startsWith("v4.public.")).toBeTrue();
    const principal = await auth.authenticate(session.accessToken);
    expect(principal.address).toBe(wallet);
    const refreshed = await auth.refresh(session.refreshToken);
    expect(refreshed.refreshToken).not.toBe(session.refreshToken);
    expect((await auth.authenticate(refreshed.accessToken)).sessionId).toBe(principal.sessionId);
    let rejected = false;
    try { await auth.refresh(session.refreshToken); }
    catch { rejected = true; }
    expect(rejected).toBeTrue();
  });

  test("verifies an EOA SIWE signature without eth_getCode", async () => {
    initializeCubane();
    const key = hexSchema.parse(`0x${"0".repeat(63)}1`);
    const wallet = signingKeyAddress(key);
    class EoaRpc extends ContractWalletRpc {
      public override async getCode(): Promise<Hex> { throw new Error("getCode must not run for EOAs"); }
      public override async call(): Promise<Hex> { throw new Error("eth_call must not run for EOAs"); }
    }
    const pair = generateKeys("public");
    const store = new MemoryAuthStore();
    const auth = await AuthService.create({
      domain: "localhost", uri: "http://localhost:3000", chainId: 1,
      issuer: "https://auth.example.com", resource: "https://api.example.com/mcp",
      secretKeyPaserk: pair.secretKey, publicKeysPaserk: [pair.publicKey],
      accessTtlSeconds: 900, refreshTtlSeconds: 3_600,
    }, store, new EoaRpc());
    const challenge = await auth.challenge(wallet);
    const session = await auth.session(challenge.challengeId, challenge.message, signPersonalMessage(key, challenge.message));
    expect((await auth.authenticate(session.accessToken)).address).toBe(wallet);
  });
});
