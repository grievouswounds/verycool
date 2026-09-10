import { createConnection } from "node:net";
import { addressSchema, hashSchema, hexSchema, parseStrictJson } from "@aqua/core";
import type { Address, AuthenticationScope, Hex } from "@aqua/core";
import { z } from "zod";

const identifier = z.uuid();
const errorSchema = z.object({ code: z.string(), message: z.string() }).strict();
const responseSchema = z.discriminatedUnion("ok", [
  z.object({ id: identifier, ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ id: identifier, ok: z.literal(false), error: errorSchema }).strict(),
]);
const grantSchema = z.object({
  address: addressSchema, sessionId: z.uuid(),
  scopes: z.array(z.enum(["trading:read", "trading:write", "activity:read", "activity:write"])).min(1),
  amr: z.array(z.enum(["siwe", "fido2", "hwk"])).min(1), clientId: z.string().min(1),
}).strict();

export const brokerRequestSchema = z.discriminatedUnion("method", [
  z.object({ id: identifier, method: z.literal("getPublicIdentity"), params: z.object({}).strict() }).strict(),
  z.object({ id: identifier, method: z.literal("issuePaseto"), params: grantSchema }).strict(),
  z.object({ id: identifier, method: z.literal("signDigest"), params: z.object({
    purpose: z.enum(["permit2", "order-lifecycle", "keeper", "facilitator"]),
    digest: hashSchema, chainId: z.number().int().positive(), token: addressSchema,
    vault: addressSchema, proxy: addressSchema, amount: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    deadline: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  }).strict() }).strict(),
  z.object({id:identifier,method:z.literal("signEip1559"),params:z.object({purpose:z.enum(["keeper","facilitator"]),chainId:z.string(),nonce:z.string(),maxPriorityFeePerGas:z.string(),maxFeePerGas:z.string(),gas:z.string(),to:addressSchema,value:z.string(),data:hexSchema}).strict()}).strict(),
]);
export type BrokerRequest = z.infer<typeof brokerRequestSchema>;
export const brokerIdentitySchema = z.object({
  agent: addressSchema, facilitator: addressSchema, keeper: addressSchema,
  pasetoPublicKey: z.string().regex(/^k4\.public\.[A-Za-z0-9_-]{43}$/u),
}).strict();
export const brokerSignatureSchema = z.object({ signature: hexSchema }).strict();
export interface BrokerAccessTokenGrant {
  readonly address: Address;
  readonly sessionId: string;
  readonly scopes: readonly AuthenticationScope[];
  readonly amr: readonly ("siwe" | "fido2" | "hwk")[];
  readonly clientId: string;
}

export type BrokerDigestRequest = Extract<BrokerRequest, { method: "signDigest" }>["params"];
export interface BrokerEip1559Transaction {
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gas: bigint;
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
};

export interface SecretBroker {
  identity(): Promise<z.infer<typeof brokerIdentitySchema>>;
  issuePaseto(grant: BrokerAccessTokenGrant): Promise<string>;
  signEip1559(transaction: BrokerEip1559Transaction, purpose?: "keeper" | "facilitator"): Promise<Hex>;
  signDigest(parameters: BrokerDigestRequest): Promise<Hex>;
}

export class SecretBrokerClient implements SecretBroker {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  public constructor(socketPath: string, timeoutMs = 5_000) { this.socketPath = socketPath; this.timeoutMs = timeoutMs; }

  public async request<Result>(method: BrokerRequest["method"], params: unknown, schema: z.ZodType<Result>): Promise<Result> {
    const id = crypto.randomUUID();
    const request = brokerRequestSchema.parse({ id, method, params });
    const line = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let received = "";
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error("Secret broker timed out")); }, this.timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => { socket.write(`${JSON.stringify(request)}\n`); });
      socket.on("data", (chunk: string) => {
        received += chunk;
        if (received.length > 65_536) { socket.destroy(); reject(new Error("Secret broker response too large")); }
        const newline = received.indexOf("\n");
        if (newline >= 0) { clearTimeout(timeout); socket.end(); resolve(received.slice(0, newline)); }
      });
      socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
      socket.on("close", () => { clearTimeout(timeout); });
    });
    const decoded = responseSchema.parse(parseStrictJson(line));
    if (decoded.id !== id) throw new Error("Secret broker response id mismatch");
    if (!decoded.ok) throw new Error(`Secret broker ${decoded.error.code}: ${decoded.error.message}`);
    return schema.parse(decoded.result);
  }

  public identity() { return this.request("getPublicIdentity", {}, brokerIdentitySchema); }
  public async issuePaseto(grant: BrokerAccessTokenGrant): Promise<string> {
    const result = await this.request("issuePaseto", grant, z.object({ token: z.string().min(1) }).strict());
    return result.token;
  }
  public async signEip1559(transaction: BrokerEip1559Transaction, purpose: "keeper" | "facilitator" = "keeper"): Promise<Hex> {
    const params = {
      purpose, chainId: transaction.chainId.toString(), nonce: transaction.nonce.toString(),
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas.toString(), maxFeePerGas: transaction.maxFeePerGas.toString(),
      gas: transaction.gas.toString(), to: transaction.to, value: transaction.value.toString(), data: transaction.data,
    };
    const result = await this.request("signEip1559", params, z.object({ rawTransaction: hexSchema }).strict());
    return result.rawTransaction;
  }
  public async signDigest(parameters: BrokerDigestRequest): Promise<Hex> {
    const result = await this.request("signDigest", parameters, brokerSignatureSchema);
    return result.signature;
  }
}
