/* eslint-disable @typescript-eslint/no-deprecated -- hosted /mcp shares Server with the stdio bridge on SDK 1.29 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AppError, addressSchema, hashSchema, hexSchema, quantitySchema, subscribedTradesWipeSchema, tradePreviewRequestSchema, tradesListQuerySchema } from "@aqua/core";
import type { Address, AuthenticatedPrincipal, Hash, Hex, RpcPort } from "@aqua/core";
import type { AgentVault, AuthService } from "@aqua/adapters";
import type { ActivityService } from "@aqua/activity";
import { LedgerX402PaymentHeaders } from "@aqua/bazantic";
import { hexToQuantity } from "@aqua/evm";
import type { Eip712TypedData } from "@aqua/evm";
import type { TradeApiService } from "@aqua/trade-api";
import { z } from "zod";
import { applyMcpCors, mcpUnauthorized } from "./cors.ts";

export interface HostedMcpDependencies {
  readonly origin: string;
  readonly auth: AuthService;
  readonly tradeApi: TradeApiService;
  readonly activity: ActivityService;
  readonly agentVault: AgentVault;
  readonly rpc: RpcPort;
}

const prerequisiteSchema = z.object({
  chainId: z.number().int().positive(), from: addressSchema, to: addressSchema, data: hexSchema,
  value: quantitySchema, gas: quantitySchema.optional(),
}).strict();
const typedDataSchema = z.custom<Eip712TypedData>((value) => typeof value === "object" && value !== null && "domain" in value && "types" in value && "primaryType" in value && "message" in value);

const jsonable = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return z.array(z.unknown()).parse(value).map(jsonable);
  if (value !== null && typeof value === "object") {
    const record = z.record(z.string(), z.unknown()).parse(value);
    return Object.fromEntries(Object.entries(record).map(([key, item]: [string, unknown]) => [key, jsonable(item)]));
  }
  return value;
};
const jsonString = (value: unknown): string => JSON.stringify(jsonable(value));
const output = (body: unknown) => {
  const safe = jsonable(body);
  return { content: [{ type: "text" as const, text: jsonString(safe) }], structuredContent: typeof safe === "object" && safe !== null ? z.record(z.string(), z.unknown()).parse(safe) : { result: safe } };
};
const schema = (value: z.ZodType): Record<string, unknown> => {
  const json = z.record(z.string(), z.unknown()).parse(z.toJSONSchema(value, { target: "draft-2020-12", io: "input" }));
  return json["type"] === "object" ? json : { type: "object", ...json };
};

const tools = [
  { name: "request_trade", description: "Resolve, quote, fully describe, and simulate an immutable trade before signing. Map natural language onto policy.kind: a market buy/sell is market; a priced resting or crossing order is limit; a stop loss is stopMarket or stopLimit; a take profit is takeProfitMarket or takeProfitLimit; linked exits are oco or bracket; a trailing stop is trailingStop. timeInForce carries ioc or fok for marketable orders and gtc or gtd for resting ones.", inputSchema: schema(tradePreviewRequestSchema) },
  { name: "post_trade", description: "Sign the reviewed lifecycle with the hosted owner agent, satisfy x402 Permit2 funding, and submit. Hosted market orders do not open a browser or Ledger. Resting and armed fills need the local order-worker.", inputSchema: schema(z.object({ previewId: z.uuid(), previewHash: hashSchema }).strict()) },
  { name: "get_trades", description: "Read own, subscribed, or combined trade records with stable filtering and sorting.", inputSchema: schema(tradesListQuerySchema) },
  { name: "cancel_trade", description: "Cancel a resting limit order or unwind an armed conditional order using the hosted agent key.", inputSchema: schema(z.object({ tradeId: z.uuid() }).strict()) },
  { name: "subscribe_to_user", description: "Subscribe to confirmed trades for an EVM address.", inputSchema: schema(z.object({ address: addressSchema }).strict()) },
  { name: "unsubscribe_from_user", description: "Stop collecting trades for an address without deleting its stored records.", inputSchema: schema(z.object({ address: addressSchema }).strict()) },
  { name: "wipe_subscribed_trades", description: "Delete stored subscribed-wallet trades for one address or all addresses; subscriptions remain active.", inputSchema: schema(subscribedTradesWipeSchema) },
] as const;

const setupHint = (owner: Address, origin: string, type: string): string => {
  const setup = `${origin.replace(/\/$/u, "")}/setup?owner=${owner}`;
  if (type === "urn:aqua:error:delegation-required") {
    return `An on-chain fixture-token delegation is required. Leave chat, run bun scripts/setup-hosted-owner.ts against ${origin}, then check ${setup}. Hosted post_trade cannot talk to the Ledger.`;
  }
  if (type === "urn:aqua:error:agent-not-bound") {
    return `No hosted agent is bound. Re-run bun scripts/setup-hosted-owner.ts so provision dual-writes agent_keys and owner_agent_bindings. Status: ${setup}.`;
  }
  return type;
};

const waitReceipt = async (rpc: RpcPort, hash: Hash, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc.transactionReceipt(hash);
    if (receipt?.status === "success") return true;
    if (receipt?.status === "reverted") throw new AppError(409, "urn:aqua:error:prerequisite", `Prerequisite transaction reverted: ${hash}`);
    await Bun.sleep(250);
  }
  return false;
};

const executePrerequisites = async (dependencies: HostedMcpDependencies, owner: Address, agent: Address, preview: Readonly<Record<string, unknown>>): Promise<readonly Hash[]> => {
  const parsed = z.object({ transactions: z.array(prerequisiteSchema).max(2) }).loose().parse(preview["prerequisites"] ?? { transactions: [] });
  const hashes: Hash[] = [];
  const session = dependencies.rpc.session?.() ?? dependencies.rpc;
  for (const transaction of parsed.transactions) {
    if (transaction.from !== agent) throw new AppError(409, "urn:aqua:error:prerequisite", "Prerequisite does not belong to the bound agent");
    const [nonce, gasPrice, priority] = await Promise.all([session.transactionCount(agent), session.gasPrice(), session.maxPriorityFeePerGas()]);
    const value = hexToQuantity(transaction.value);
    const gas = transaction.gas === undefined ? await session.estimateGas({ from: agent, to: transaction.to, data: transaction.data, value: transaction.value }) : hexToQuantity(transaction.gas);
    const raw = await dependencies.agentVault.signTransaction(owner, {
      chainId: BigInt(transaction.chainId), nonce, maxPriorityFeePerGas: priority, maxFeePerGas: gasPrice * 2n + priority, gas, to: transaction.to, value, data: transaction.data,
    });
    const hash = await session.sendRawTransaction(raw);
    hashes.push(hash);
    await waitReceipt(session, hash, 8_000);
  }
  return hashes;
};

const callTool = async (dependencies: HostedMcpDependencies, principal: AuthenticatedPrincipal, name: string, arguments_: unknown): Promise<ReturnType<typeof output>> => {
  const owner = principal.address;
  const origin = dependencies.origin;
  try {
    if (name === "request_trade") {
      const result = await dependencies.tradeApi.createPreview(tradePreviewRequestSchema.parse(arguments_), principal);
      return output(result.body);
    }
    if (name === "post_trade") {
      const { previewId, previewHash } = z.object({ previewId: z.uuid(), previewHash: hashSchema }).strict().parse(arguments_);
      const preview = await dependencies.tradeApi.reviewedPreview(previewId, owner);
      if (preview["previewHash"] !== previewHash) throw new AppError(409, "urn:aqua:error:preview-hash", "Trade preview hash does not match");
      const policy = z.object({ kind: z.string() }).loose().safeParse(z.record(z.string(), z.unknown()).parse(preview["normalizedTrade"] ?? {})["policy"]);
      if (policy.success && policy.data.kind !== "market") {
        return output({ warning: "Hosted demo fills are market orders. Resting and armed orders need the local order-worker or stdio bridge.", previewId, previewHash });
      }
      const lifecycle = typedDataSchema.parse(preview["lifecycle"]);
      const additional = z.array(typedDataSchema).parse(preview["additionalLifecycles"] ?? []);
      const lifecycleSignature = await dependencies.agentVault.signLifecycle(owner, lifecycle);
      const additionalLifecycleSignatures: Hex[] = [];
      for (const typed of additional) additionalLifecycleSignatures.push(await dependencies.agentVault.signLifecycle(owner, typed));
      const agent = addressSchema.parse(preview["agent"]);
      const hashes = await executePrerequisites(dependencies, owner, agent, preview);
      const input = { previewId, previewHash, lifecycleSignature, ...(additionalLifecycleSignatures.length === 0 ? {} : { additionalLifecycleSignatures }) };
      let result = await dependencies.tradeApi.submit(input, principal, null, hashes);
      if (result.status === 402 && result.paymentRequired !== undefined) {
        const headers = await new LedgerX402PaymentHeaders({
          address: z.custom<`0x${string}`>((value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value)).parse(agent),
          signTypedData: (request) => dependencies.agentVault.signPermit2(owner, typedDataSchema.parse(request)).then((signature) => z.custom<`0x${string}`>((value) => typeof value === "string" && /^0x[0-9a-fA-F]{130}$/u.test(value)).parse(signature)),
        }).create(result.paymentRequired, { kind: "aqua", network: `eip155:${String(preview["chainId"])}` });
        const payment = headers["payment-signature"] ?? headers["PAYMENT-SIGNATURE"] ?? null;
        result = await dependencies.tradeApi.submit(input, principal, payment, hashes);
      }
      return output(result.body);
    }
    if (name === "get_trades") return output(await dependencies.tradeApi.listTrades(tradesListQuerySchema.parse(arguments_), owner));
    if (name === "cancel_trade") {
      const { tradeId } = z.object({ tradeId: z.uuid() }).strict().parse(arguments_);
      const created = await dependencies.tradeApi.createCancellation(tradeId, owner);
      const signature = await dependencies.agentVault.signLifecycle(owner, typedDataSchema.parse(created.lifecycle));
      return output(await dependencies.tradeApi.submitCancellation(tradeId, created.cancellationId, owner, signature));
    }
    if (name === "subscribe_to_user") {
      const { address } = z.object({ address: addressSchema }).strict().parse(arguments_);
      return output(await dependencies.activity.subscribe(address, principal));
    }
    if (name === "unsubscribe_from_user") {
      const { address } = z.object({ address: addressSchema }).strict().parse(arguments_);
      return output({ removed: await dependencies.activity.unsubscribe(address, principal) });
    }
    if (name === "wipe_subscribed_trades") {
      return output(await dependencies.tradeApi.wipeSubscribed(subscribedTradesWipeSchema.parse(arguments_), owner));
    }
    throw new AppError(404, "urn:aqua:error:tool", "Unknown tool");
  } catch (error: unknown) {
    if (error instanceof AppError) throw new AppError(error.status, error.type, setupHint(owner, origin, error.type) === error.type ? error.message : `${error.message} ${setupHint(owner, origin, error.type)}`, error.details);
    throw error;
  }
};

const authenticateMcp = async (request: Request, auth: AuthService): Promise<AuthenticatedPrincipal> => {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ") !== true) throw new AppError(401, "urn:aqua:error:authentication", "Bearer access token is required");
  const principal = await auth.authenticate(header.slice(7));
  if (!principal.scopes.has("trading:write") && !principal.scopes.has("trading:read")) {
    throw new AppError(403, "urn:aqua:error:scope", "Required scope: trading:write", { requiredScope: "trading:write" });
  }
  return principal;
};

export const handleHostedMcp = async (request: Request, dependencies: HostedMcpDependencies): Promise<Response> => {
  if (request.method === "OPTIONS") {
    const response = new Response(null, { status: 204 });
    return applyMcpCors(response, request);
  }
  if (request.method !== "POST") {
    return mcpUnauthorized(dependencies.origin, request, null, 405);
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { body = null; }
  let principal: AuthenticatedPrincipal;
  try { principal = await authenticateMcp(request, dependencies.auth); }
  catch (error: unknown) {
    if (error instanceof AppError && error.status === 401) return mcpUnauthorized(dependencies.origin, request, body);
    throw error;
  }
  const server = new Server({ name: "aqua", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (rpcRequest) => {
    const arguments_: unknown = rpcRequest.params.arguments ?? {};
    return await callTool(dependencies, principal, rpcRequest.params.name, arguments_);
  });
  // Omit sessionIdGenerator: SDK 1.29 treats that as stateless. exactOptionalPropertyTypes forbids passing undefined.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request, { parsedBody: body });
    return applyMcpCors(response, request);
  } finally {
    await transport.close();
  }
};
