import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import { AppError, addressSchema, hexSchema } from "@aqua/core";
import type { Address, Hex } from "@aqua/core";
import { CubaneTransactionSigner, randomSigningKey, signTypedData, signingKeyAddress } from "@aqua/evm";
import type { Eip1559Transaction, Eip712TypedData } from "@aqua/evm";

const PREFIX = Buffer.from("AQUA1");
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

export const parseAgentKek = (value: string): Buffer => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("AQUA_AGENT_KEK is missing");
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]{64}$/u.test(hex)) return Buffer.from(hex, "hex");
  throw new Error("AQUA_AGENT_KEK must be exactly 32 bytes (64 hex characters)");
};

export const wrapAgentKey = (kek: Buffer, owner: Address, privateKey: Hex): Buffer => {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  cipher.setAAD(Buffer.from(owner));
  const body = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([PREFIX, nonce, body]);
};

export const unwrapAgentKey = (kek: Buffer, owner: Address, wrapped: Buffer): Hex => {
  if (wrapped.length < PREFIX.length + NONCE_LENGTH + TAG_LENGTH + 32 || !wrapped.subarray(0, PREFIX.length).equals(PREFIX)) {
    throw new AppError(500, "urn:aqua:error:agent-wrap", "Agent key envelope is malformed");
  }
  const nonce = wrapped.subarray(PREFIX.length, PREFIX.length + NONCE_LENGTH);
  const tag = wrapped.subarray(wrapped.length - TAG_LENGTH);
  const ciphertext = wrapped.subarray(PREFIX.length + NONCE_LENGTH, wrapped.length - TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", kek, nonce);
  decipher.setAAD(Buffer.from(owner));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return hexSchema.parse(`0x${plain.toString("hex")}`);
};

const kekIdFor = (kek: Buffer): string => createHash("sha256").update(kek).digest("hex").slice(0, 16);
const rows = <T>(value: T | T[]): T[] => Array.isArray(value) ? value : [value];

interface AgentKeyRow { owner: Address; agent: Address; wrapped_key: Buffer }

export class AgentVault {
  private readonly database: SQL;
  private readonly kek: Buffer;
  private readonly kekId: string;

  public constructor(database: SQL, kek: Buffer) {
    if (kek.length !== 32) throw new Error("AQUA_AGENT_KEK must be exactly 32 bytes");
    this.database = database;
    this.kek = kek;
    this.kekId = kekIdFor(kek);
  }

  public async provision(ownerInput: Address): Promise<{ readonly owner: Address; readonly agent: Address }> {
    const owner = addressSchema.parse(ownerInput);
    const existing = rows(await this.database<AgentKeyRow>`SELECT owner,agent,wrapped_key FROM agent_keys WHERE owner=${owner}`)[0];
    if (existing !== undefined) {
      await this.database`INSERT INTO owner_agent_bindings(owner,agent,bound_at,revoked_at) VALUES(${owner},${existing.agent},now(),NULL) ON CONFLICT(owner) DO UPDATE SET agent=EXCLUDED.agent,bound_at=EXCLUDED.bound_at,revoked_at=NULL`;
      return { owner, agent: existing.agent };
    }
    const privateKey = randomSigningKey();
    const agent = signingKeyAddress(privateKey);
    const wrapped = wrapAgentKey(this.kek, owner, privateKey);
    const context = { kek_id: this.kekId, alg: "aes-256-gcm" };
    await this.database.begin(async (transaction) => {
      await transaction`INSERT INTO agent_keys(owner,agent,wrapped_key,wrap_scheme,wrap_context) VALUES(${owner},${agent},${wrapped},'server-kek',${JSON.stringify(context)}::jsonb)`;
      await transaction`INSERT INTO owner_agent_bindings(owner,agent,bound_at,revoked_at) VALUES(${owner},${agent},now(),NULL) ON CONFLICT(owner) DO UPDATE SET agent=EXCLUDED.agent,bound_at=EXCLUDED.bound_at,revoked_at=NULL`;
    });
    return { owner, agent };
  }

  public async peekAgent(ownerInput: Address): Promise<Address | null> {
    const owner = addressSchema.parse(ownerInput);
    const row = rows(await this.database<{ agent: Address }>`SELECT agent FROM owner_agent_bindings WHERE owner=${owner} AND revoked_at IS NULL`)[0];
    return row?.agent ?? null;
  }

  public async agentAddress(ownerInput: Address): Promise<Address> {
    const agent = await this.peekAgent(ownerInput);
    if (agent === null) throw new AppError(409, "urn:aqua:error:agent-not-bound", "Owner has no provisioned hosted agent");
    return agent;
  }

  public async signLifecycle(owner: Address, typedData: Eip712TypedData): Promise<Hex> {
    return this.withKey(owner, (key) => signTypedData(key, typedData));
  }

  public async signPermit2(owner: Address, typedData: Eip712TypedData): Promise<Hex> {
    return this.withKey(owner, (key) => signTypedData(key, typedData));
  }

  public async signTransaction(owner: Address, transaction: Eip1559Transaction): Promise<Hex> {
    return this.withKey(owner, (key) => new CubaneTransactionSigner(key).sign(transaction));
  }

  private async withKey<T>(ownerInput: Address, use: (key: Hex) => T): Promise<T> {
    const owner = addressSchema.parse(ownerInput);
    const row = rows(await this.database<AgentKeyRow>`SELECT owner,agent,wrapped_key FROM agent_keys WHERE owner=${owner}`)[0];
    if (row === undefined) throw new AppError(409, "urn:aqua:error:agent-not-bound", "Owner has no provisioned hosted agent");
    const key = unwrapAgentKey(this.kek, owner, Buffer.from(row.wrapped_key));
    return use(key);
  }
}
