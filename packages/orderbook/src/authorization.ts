import { randomBytes, randomUUID } from "node:crypto";
import { AppError, hashSchema, hexSchema, parseStrictJson } from "@aqua/core";
import type { Address, Hash, Hex, RpcPort, TradingRequest } from "@aqua/core";
import { encodeIsValidSignature, hashTypedAuthorization, keccakHex, recoverTypedAuthorizationAddress } from "@aqua/evm";
import type { AuthorizationRequirement, StoredIntent, TradingRepository } from "./types.ts";

export interface AuthorizationConfiguration {
  readonly chainId: number;
  readonly controller: Address;
  readonly validitySeconds: number;
}

const commandHash = (command: TradingRequest): Hash => hashSchema.parse(keccakHex(new TextEncoder().encode(JSON.stringify(command))));
const nonce = (): Hash => hashSchema.parse(`0x${randomBytes(32).toString("hex")}`);

export class IntentAuthorizationService {
  private readonly repository: TradingRepository;
  private readonly rpc: RpcPort;
  private readonly config: AuthorizationConfiguration;
  private readonly now: () => Date;

  public constructor(
    repository: TradingRepository,
    rpc: RpcPort,
    config: AuthorizationConfiguration,
    now: () => Date = () => new Date(),
  ) { this.repository = repository; this.rpc = rpc; this.config = config; this.now = now; }

  public async challenge(command: TradingRequest, maker: Address): Promise<AuthorizationRequirement> {
    const authorizationId = randomUUID();
    const validBefore = new Date(this.now().getTime() + this.config.validitySeconds * 1_000);
    const intent: StoredIntent = {
      id: authorizationId, maker, commandHash: commandHash(command), command,
      status: "awaitingAuthorization", nonce: nonce(), validBefore,
    };
    await this.repository.saveRequirement(intent);
    return {
      profile: "aqua-intent-v1", authorizationId, validBefore: validBefore.toISOString(),
      typedData: this.typedData(intent), requiredTransactions: [],
    };
  }

  public async authorize(command: TradingRequest, maker: Address, encodedHeader: string): Promise<StoredIntent> {
    if (encodedHeader.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(encodedHeader)) {
      throw new AppError(400, "urn:aqua:error:authorization-header", "Invalid Aqua authorization header");
    }
    const bytes = Buffer.from(encodedHeader, "base64url");
    if (bytes.toString("base64url") !== encodedHeader) throw new AppError(400, "urn:aqua:error:authorization-header", "Invalid Aqua authorization header");
    let decoded: unknown;
    try { decoded = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new AppError(400, "urn:aqua:error:authorization-header", "Invalid Aqua authorization header"); }
    if (typeof decoded !== "object" || decoded === null) throw new AppError(400, "urn:aqua:error:authorization-header", "Invalid Aqua authorization payload");
    const record = Object.fromEntries(Object.entries(decoded));
    const authorizationId = typeof record["authorizationId"] === "string" ? record["authorizationId"] : "";
    const signature = hexSchema.refine((value) => value.length === 132).safeParse(record["signature"]);
    if (authorizationId === "" || !signature.success) throw new AppError(400, "urn:aqua:error:authorization-header", "Invalid Aqua authorization payload");
    const expectedHash = commandHash(command);
    const pending = await this.repository.getRequirement(authorizationId);
    if (pending?.status !== "awaitingAuthorization" || pending.commandHash !== expectedHash
      || pending.maker !== maker || pending.validBefore <= this.now()) {
      throw new AppError(409, "urn:aqua:error:authorization-replay", "Authorization is missing, expired, mismatched, or already consumed");
    }
    await this.verifySignature(pending, signature.data);
    const consumed = await this.repository.consumeRequirement(authorizationId, expectedHash, maker, signature.data, this.now());
    if (consumed === null) throw new AppError(409, "urn:aqua:error:authorization-replay", "Authorization is missing, expired, mismatched, or already consumed");
    return { ...consumed, status: "active", signature: signature.data };
  }

  private typedData(intent: StoredIntent): Readonly<Record<string, unknown>> {
    return {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" }, { name: "version", type: "string" },
          { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
        ],
        AquaIntent: [
          { name: "maker", type: "address" }, { name: "commandHash", type: "bytes32" },
          { name: "nonce", type: "bytes32" }, { name: "validBefore", type: "uint256" },
        ],
      },
      primaryType: "AquaIntent",
      domain: { name: "Aqua Agent Order Book", version: "1", chainId: this.config.chainId, verifyingContract: this.config.controller },
      message: {
        maker: intent.maker, commandHash: intent.commandHash, nonce: intent.nonce,
        validBefore: Math.floor(intent.validBefore.getTime() / 1_000),
      },
    };
  }

  private async verifySignature(intent: StoredIntent, signature: Hex): Promise<void> {
    const typedData = {
      chainId: this.config.chainId, controller: this.config.controller, maker: intent.maker,
      commandHash: intent.commandHash, nonce: intent.nonce,
      validBefore: BigInt(Math.floor(intent.validBefore.getTime() / 1_000)),
    };
    if ((await this.rpc.getCode(intent.maker)).length > 2) {
      const digest = hashTypedAuthorization(typedData);
      const result = await this.rpc.call({ to: intent.maker, data: encodeIsValidSignature(digest, signature) });
      if (!result.startsWith("0x1626ba7e")) throw new AppError(401, "urn:aqua:error:authorization-signature", "EIP-1271 authorization was rejected");
      return;
    }
    let recovered: Address;
    try { recovered = recoverTypedAuthorizationAddress(typedData, signature); }
    catch { throw new AppError(401, "urn:aqua:error:authorization-signature", "Invalid EIP-712 authorization signature"); }
    if (recovered !== intent.maker) throw new AppError(401, "urn:aqua:error:authorization-signature", "Authorization signer does not match maker");
  }
}
