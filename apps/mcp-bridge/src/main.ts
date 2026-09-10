import "./json-bigint.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
/* type-coverage:ignore-next-line -- MCP SDK 1.12 publishes Zod 3 schemas while the application uses Zod 4. */
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PayingHttpClient, parseHttpJson } from "@aqua/bazantic";
import {
  addressSchema, formatTokenAmount, hashSchema, hexSchema, localProfileDefaults, quantitySchema, subscribedTradesWipeSchema,
  tradePreviewRequestSchema, tradesListQuerySchema,
} from "@aqua/core";
import type { Address, Hash, Hex } from "@aqua/core";
import { hexToQuantity, createPooledRpcClient } from "@aqua/evm";
import { z } from "zod";
import { applyLedgerArgv } from "../../../scripts/ledger-mode.ts";
import { oauthAccessToken } from "./oauth.ts";
import { signLedgerTypedData } from "./ledger.ts";
import { retryAquaPayment } from "./payment.ts";
import { discoverConfiguredAquaTools } from "./bazantic-tools.ts";

applyLedgerArgv(Bun.argv.slice(2));

const configurationSchema = z.object({
  apiUrl: z.url(), rpcUrl: z.url(), agent: addressSchema, signerProgram: z.string().min(1),
  previewCachePath: z.string().min(1), oauthCachePath: z.string().min(1), oauthCallbackPort: z.number().int().min(1024).max(65535),
}).strict();
type HexSignature = `0x${string}`;
const hexSignatureSchema = z.custom<HexSignature>((value) => typeof value === "string" && /^0x[0-9a-fA-F]{130}$/u.test(value));
const clientAddressSchema = z.custom<`0x${string}`>((value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value));
const chainIdSchema = z.union([z.number().int().positive().transform(String), z.string().regex(/^[1-9][0-9]*$/u)]);

const stateRoot = Bun.env["XDG_STATE_HOME"] ?? "/tmp/aqua-mcp";
const signerProgram = Bun.env["AQUA_AGENT_SIGNER"] ?? `${import.meta.dir}/signer.ts`;
const ciphertextPath = Bun.env["AQUA_AGENT_CIPHERTEXT"] ?? `${stateRoot}/agent.enc`;
const metadataPath = Bun.env["AQUA_AGENT_METADATA"] ?? `${stateRoot}/agent.json`;
Bun.env["AQUA_AGENT_CIPHERTEXT"] = ciphertextPath; Bun.env["AQUA_AGENT_METADATA"] = metadataPath;
const apiUrl = Bun.env["AQUA_API_URL"] ?? "http://127.0.0.1:3000";
const oauthCachePath = Bun.env["AQUA_OAUTH_CACHE"] ?? `${stateRoot}/oauth.json`;
const oauthCallbackPort = Number(Bun.env["AQUA_OAUTH_CALLBACK_PORT"] ?? "41739");
const rpcUrl = Bun.env["AQUA_RPC_URL"] ?? "http://127.0.0.1:8545";
const previewCachePath = Bun.env["AQUA_PREVIEW_CACHE"] ?? `${stateRoot}/previews.json`;
const rpc = createPooledRpcClient({ id: Number.parseInt(Bun.env["AQUA_CHAIN_ID"] ?? "31337", 10), rpcUrl }, localProfileDefaults.rpcTimeoutMs);
type BridgeConfig = z.infer<typeof configurationSchema>;
interface Session {
  readonly accessToken: string;
  readonly config: BridgeConfig;
  readonly http: PayingHttpClient;
}
let sessionPromise: Promise<Session> | undefined;

const signTypedData = async (config: BridgeConfig, typedData: Readonly<Record<string, unknown>>): Promise<`0x${string}`> => {
  const child = Bun.spawn([process.execPath, config.signerProgram, "sign-typed-data"], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: Bun.env });
  await child.stdin.write(jsonString({ typedData })); await child.stdin.end();
  const text = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error("Isolated LKRP signer failed");
  const result = z.object({ address: addressSchema, signature: hexSignatureSchema }).strict().parse(JSON.parse(text));
  if (result.address !== config.agent) throw new Error("Signer address does not match the bound agent");
  return result.signature;
};

const prerequisiteSchema = z.object({
  chainId: z.number().int().positive(), from: addressSchema, to: addressSchema, data: hexSchema,
  value: quantitySchema, gas: quantitySchema.optional(),
}).strict();
const prerequisitesSchema = z.object({ transactions: z.array(prerequisiteSchema).max(2) }).loose();
const signedTransactionSchema = z.object({ address: addressSchema, rawTransaction: hexSchema }).strict();
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
const signTransaction = async (config: BridgeConfig, transaction: { readonly chainId: number; readonly nonce: bigint; readonly maxPriorityFeePerGas: bigint; readonly maxFeePerGas: bigint; readonly gas: bigint; readonly to: Address; readonly value: bigint; readonly data: Hex }): Promise<Hex> => {
  const child = Bun.spawn([process.execPath, config.signerProgram, "sign-transaction"], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: Bun.env });
  await child.stdin.write(jsonString({ transaction: {
    chainId: transaction.chainId, to: transaction.to, data: transaction.data,
    nonce: transaction.nonce.toString(), maxPriorityFeePerGas: transaction.maxPriorityFeePerGas.toString(),
    maxFeePerGas: transaction.maxFeePerGas.toString(), gas: transaction.gas.toString(), value: transaction.value.toString(),
  } }));
  await child.stdin.end(); const text = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error("Isolated LKRP transaction signer failed");
  const result = signedTransactionSchema.parse(JSON.parse(text));
  if (result.address !== config.agent) throw new Error("Transaction signer address does not match the bound agent");
  return result.rawTransaction;
};
const waitForReceipt = async (hash: Hash): Promise<void> => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const receipt = await rpc.transactionReceipt(hash);
    if (receipt?.status === "success") return;
    if (receipt?.status === "reverted") throw new Error(`Prerequisite transaction reverted: ${hash}`);
    await Bun.sleep(500);
  }
  throw new Error(`Prerequisite transaction confirmation timed out: ${hash}`);
};
const executePrerequisites = async (session: Session, preview: Readonly<Record<string, unknown>>): Promise<readonly Hash[]> => {
  const parsed = prerequisitesSchema.parse(preview["prerequisites"]); const hashes: Hash[] = [];
  for (const transaction of parsed.transactions) {
    if (transaction.from !== session.config.agent || transaction.chainId !== preview["chainId"]) throw new Error("Reviewed prerequisite transaction does not belong to the local agent and chain");
    const pinned = rpc.session();
    const [nonce, gasPrice, priority] = await Promise.all([pinned.transactionCount(session.config.agent), pinned.gasPrice(), pinned.maxPriorityFeePerGas()]);
    const gas = transaction.gas === undefined ? await pinned.estimateGas({ from: session.config.agent, to: transaction.to, data: transaction.data, value: transaction.value }) : hexToQuantity(transaction.gas);
    const raw = await signTransaction(session.config, { chainId: transaction.chainId, nonce, maxPriorityFeePerGas: priority, maxFeePerGas: gasPrice * 2n + priority, gas, to: transaction.to, value: hexToQuantity(transaction.value), data: transaction.data });
    const hash = await pinned.sendRawTransaction(raw); hashes.push(hash); await waitForReceipt(hash);
  }
  return hashes;
};

const delegationContextSchema = z.object({
  owner: addressSchema,
  normalizedTrade: z.object({ sellToken: addressSchema }).loose(),
  tokens: z.object({ sell: z.object({ decimals: z.number().int().min(0).max(255) }).loose() }).loose(),
  execution: z.object({
    fundingAmountUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    action: z.object({ deadline: z.string().regex(/^(?:0|[1-9][0-9]*)$/u) }).loose().optional(),
  }).loose(),
  delegation: z.object({ suggestedExpiresAt: z.iso.datetime({ offset: true }).optional() }).loose().optional(),
}).loose();
const delegationPreviewSchema = z.object({ previewId: z.uuid(), previewHash: hashSchema, typedData: z.record(z.string(), z.unknown()) }).loose();
const delegationSubmissionSchema = z.object({ transactionHash: hashSchema }).loose();

const api = async (session: Session, path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${session.accessToken}`);
  return session.http.requestPlain(new URL(path, session.config.apiUrl), { ...init, headers });
};
const json = async (response: Response): Promise<unknown> => {
  const { body } = await parseHttpJson(response);
  if (!response.ok) throw new Error(`Aqua API ${String(response.status)}: ${jsonString(body)}`);
  return body;
};

const ensureDelegation = async (session: Session, preview: Readonly<Record<string, unknown>>): Promise<Hash> => {
  const context = delegationContextSchema.parse(preview);
  const units = BigInt(context.execution.fundingAmountUnits);
  const decimals = context.tokens.sell.decimals;
  const amount = formatTokenAmount(units, decimals);
  // One preview suggests a single-order daily cap. A session of same-token trades
  // (market, crossing, resting, stops) needs headroom without another Ledger signature.
  const daily = formatTokenAmount(units * 100n, decimals);
  const deadlineMs = context.execution.action === undefined ? Date.now() + 86_400_000 : Number(context.execution.action.deadline) * 1_000;
  const expiresAt = context.delegation?.suggestedExpiresAt ?? new Date(Math.max(deadlineMs + 86_400_000, Date.now() + 86_400_000)).toISOString();
  const created = delegationPreviewSchema.parse(await json(await api(session, "/v1/delegations/previews", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      agent: session.config.agent, token: context.normalizedTrade.sellToken, maxPerOrder: amount, maxPerDay: daily,
      expiresAt,
    }),
  })));
  const ownerSignature = await signLedgerTypedData(context.owner, created.typedData);
  const submitted = delegationSubmissionSchema.parse(await json(await api(session, "/v1/delegations", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewId: created.previewId, previewHash: created.previewHash, ownerSignature }),
  })));
  await waitForReceipt(submitted.transactionHash); return submitted.transactionHash;
};

const ensureAgentBinding = async (session: Session): Promise<void> => {
  const challengeResponse = await api(session, "/v1/agents/me/challenges", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: session.config.agent }),
  });
  const challenge = z.object({ challengeId: z.uuid(), typedData: z.record(z.string(), z.unknown()) }).loose().parse(await json(challengeResponse));
  const signature = await signTypedData(session.config, challenge.typedData);
  await json(await api(session, "/v1/agents/me", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, agent: session.config.agent, signature }),
  }));
};

const loadOrProvisionAgent = async (): Promise<string> => {
  const configured = Bun.env["AQUA_AGENT_ADDRESS"];
  if (configured !== undefined) return configured;
  try { return z.looseObject({ address: addressSchema }).parse(JSON.parse(await readFile(metadataPath, "utf8"))).address; }
  catch {
    const provision = Bun.spawn([process.execPath, signerProgram, "provision"], { stdin: "inherit", stdout: "pipe", stderr: "inherit", env: Bun.env });
    const result = z.looseObject({ address: addressSchema }).parse(JSON.parse(await new Response(provision.stdout).text()));
    if (await provision.exited !== 0) throw new Error("Ledger Key Ring agent provisioning failed");
    return result.address;
  }
};

const ensureSession = (): Promise<Session> => {
  sessionPromise ??= (async () => {
    const bazanticEvidence = await discoverConfiguredAquaTools();
    if (bazanticEvidence !== null) console.error(JSON.stringify({
      level: "info", component: "aqua-mcp", message: "Bazantic Aqua tool catalog verified",
      gatewaySlug: bazanticEvidence.gatewaySlug, mcpUrl: bazanticEvidence.mcpUrl,
      fingerprints: bazanticEvidence.fingerprints,
    }));
    const accessToken = await oauthAccessToken(apiUrl, oauthCachePath, oauthCallbackPort);
    const config = configurationSchema.parse({
      apiUrl, rpcUrl, agent: await loadOrProvisionAgent(), signerProgram, previewCachePath, oauthCachePath, oauthCallbackPort,
    });
    const session: Session = {
      accessToken,
      config,
      http: new PayingHttpClient({
        signer: {
          address: clientAddressSchema.parse(config.agent),
          signTypedData: (request) => signTypedData(config, request),
        },
      }),
    };
    await ensureAgentBinding(session);
    return session;
  })();
  return sessionPromise;
};

const loadCache = async (session: Session): Promise<Record<string, Readonly<Record<string, unknown>>>> => {
  try { return z.record(z.string(), z.record(z.string(), z.unknown())).parse(JSON.parse(await readFile(session.config.previewCachePath, "utf8"))); }
  catch { return {}; }
};
const savePreview = async (session: Session, body: Readonly<Record<string, unknown>>): Promise<void> => {
  const id = z.uuid().parse(body["previewId"]); const cache = await loadCache(session); cache[id] = body;
  await mkdir(dirname(session.config.previewCachePath), { recursive: true, mode: 0o700 });
  await writeFile(session.config.previewCachePath, JSON.stringify(cache), { mode: 0o600 });
};

const requestTrade = async (session: Session, arguments_: unknown) => {
  const parsed = tradePreviewRequestSchema.parse(arguments_);
  const response = await api(session, "/v1/trade-previews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed) });
  const body = await json(response); if (response.status === 201) await savePreview(session, z.record(z.string(), z.unknown()).parse(body)); return output(body);
};
const postTrade = async (session: Session, arguments_: unknown) => {
  const { previewId, previewHash } = z.object({ previewId: z.uuid(), previewHash: hashSchema }).strict().parse(arguments_);
  const preview = (await loadCache(session))[previewId]; if (preview?.["previewHash"] !== previewHash) throw new Error("Reviewed preview is not present in the local cache");
  const lifecycle = z.record(z.string(), z.unknown()).parse(preview["lifecycle"]); const signature = await signTypedData(session.config, lifecycle);
  const additional = z.array(z.record(z.string(), z.unknown())).parse(preview["additionalLifecycles"] ?? []);
  const additionalLifecycleSignatures: string[] = [];
  for (const typed of additional) additionalLifecycleSignatures.push(await signTypedData(session.config, typed));
  const body = JSON.stringify({ previewId, previewHash, lifecycleSignature: signature, ...(additionalLifecycleSignatures.length === 0 ? {} : { additionalLifecycleSignatures }) });
  const headers = new Headers({ "content-type": "application/json", "idempotency-key": previewId });
  headers.set("authorization", `Bearer ${session.accessToken}`);
  let validation = await api(session, "/v1/trades", { method: "POST", headers, body });
  if (validation.status === 409) {
    const validationResult = await parseHttpJson(validation);
    const error = z.object({ type: z.string() }).loose().safeParse(validationResult.body);
    if (!error.success || error.data.type !== "urn:aqua:error:delegation-required") throw new Error(`Aqua API 409: ${jsonString(validationResult.body)}`);
    await ensureDelegation(session, preview); validation = await api(session, "/v1/trades", { method: "POST", headers, body });
  }
  if (validation.status !== 402) return output(await json(validation));
  const prerequisiteTransactionHashes = await executePrerequisites(session, preview);
  headers.set("aqua-prerequisite-transactions", Buffer.from(JSON.stringify(prerequisiteTransactionHashes)).toString("base64url"));
  const network = `eip155:${chainIdSchema.parse(preview["chainId"])}` as const;
  const response = await retryAquaPayment(session.http, validation, new URL("/v1/trades", session.config.apiUrl), { method: "POST", headers, body }, network);
  return output(await json(response));
};
const getTrades = async (session: Session, arguments_: unknown) => {
  const parsed = tradesListQuerySchema.parse(arguments_);
  const query = new URLSearchParams(); for (const [key, value] of Object.entries(parsed)) if (value !== undefined) query.set(key, String(value));
  return output(await json(await api(session, `/v1/trades?${query.toString()}`)));
};
const subscription = async (session: Session, arguments_: unknown, remove: boolean) => { const { address } = z.object({ address: addressSchema }).strict().parse(arguments_); return output(await json(await api(session, remove ? `/v1/trade-subscriptions/${address}` : "/v1/trade-subscriptions", remove ? { method: "DELETE" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) }))); };
const wipe = async (session: Session, arguments_: unknown) => { const parsed = subscribedTradesWipeSchema.parse(arguments_); return output(await json(await api(session, "/v1/trade-subscriptions/trades/wipe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed) }))); };
const cancelTrade = async (session: Session, arguments_: unknown) => {
  const { tradeId } = z.object({ tradeId: z.uuid() }).strict().parse(arguments_);
  const created = z.object({ cancellationId: z.uuid(), cancellationHash: hashSchema, lifecycle: z.record(z.string(), z.unknown()) }).loose()
    .parse(await json(await api(session, `/v1/trades/${tradeId}/cancellations`, { method: "POST" })));
  const signature = await signTypedData(session.config, created.lifecycle);
  return output(await json(await api(session, `/v1/trades/${tradeId}/cancellations/${created.cancellationId}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature }),
  })));
};

const schema = (value: z.ZodType): Record<string, unknown> => {
  const json = z.record(z.string(), z.unknown()).parse(z.toJSONSchema(value, { target: "draft-2020-12", io: "input" }));
  return json["type"] === "object" ? json : { type: "object", ...json };
};
const tools = [
  { name: "request_trade", description: "Resolve, quote, fully describe, and simulate an immutable trade before signing. Map natural language onto policy.kind: a market buy/sell is market; a priced resting or crossing order is limit; a stop loss is stopMarket or stopLimit; a take profit is takeProfitMarket or takeProfitLimit; linked exits are oco or bracket; a trailing stop is trailingStop. timeInForce carries ioc or fok for marketable orders and gtc or gtd for resting ones.", inputSchema: schema(tradePreviewRequestSchema) },
  { name: "post_trade", description: "Sign the reviewed lifecycle plan locally, satisfy its exact x402 Permit2 funding request, and submit it.", inputSchema: schema(z.object({ previewId: z.uuid(), previewHash: hashSchema }).strict()) },
  { name: "get_trades", description: "Read own, subscribed, or combined trade records with stable filtering and sorting.", inputSchema: schema(tradesListQuerySchema) },
  { name: "cancel_trade", description: "Cancel a resting limit order or unwind an armed conditional order, returning vault funds to the Ledger owner.", inputSchema: schema(z.object({ tradeId: z.uuid() }).strict()) },
  { name: "subscribe_to_user", description: "Subscribe to confirmed trades for an EVM address.", inputSchema: schema(z.object({ address: addressSchema }).strict()) },
  { name: "unsubscribe_from_user", description: "Stop collecting trades for an address without deleting its stored records.", inputSchema: schema(z.object({ address: addressSchema }).strict()) },
  { name: "wipe_subscribed_trades", description: "Delete stored subscribed-wallet trades for one address or all addresses; subscriptions remain active.", inputSchema: schema(subscribedTradesWipeSchema) },
] as const;
const server = new Server({ name: "aqua-ledger-key-ring", version: "1.0.0" }, { capabilities: { tools: {} } });
/* type-coverage:ignore-next-line -- request schema inference is untyped upstream across the Zod major-version boundary. */
server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools }));
/* type-coverage:ignore-next-line -- request schema inference is untyped upstream across the Zod major-version boundary. */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const session = await ensureSession();
    const arguments_: unknown = request.params.arguments ?? {};
    if (request.params.name === "request_trade") return requestTrade(session, arguments_);
    if (request.params.name === "post_trade") return postTrade(session, arguments_);
    if (request.params.name === "get_trades") return getTrades(session, arguments_);
    if (request.params.name === "cancel_trade") return cancelTrade(session, arguments_);
    if (request.params.name === "subscribe_to_user") return subscription(session, arguments_, false);
    if (request.params.name === "unsubscribe_from_user") return subscription(session, arguments_, true);
    if (request.params.name === "wipe_subscribed_trades") return wipe(session, arguments_);
    throw new Error("Unknown tool");
  } catch (error) {
    console.error(error);
    throw error;
  }
});
await server.connect(new StdioServerTransport());
