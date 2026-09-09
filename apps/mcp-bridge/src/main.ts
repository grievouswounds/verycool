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
import { hexToQuantity, JsonRpcClient } from "@aqua/evm";
import { z } from "zod";
import { oauthAccessToken } from "./oauth.ts";
import { signLedgerTypedData } from "./ledger.ts";
import { retryAquaPayment } from "./payment.ts";
import { discoverConfiguredAquaTools } from "./bazantic-tools.ts";

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
let agentAddress = Bun.env["AQUA_AGENT_ADDRESS"];
if (agentAddress === undefined) {
  try { agentAddress = z.looseObject({ address: addressSchema }).parse(JSON.parse(await readFile(metadataPath, "utf8"))).address; }
  catch {
    const provision = Bun.spawn([process.execPath, signerProgram, "provision"], { stdin: "inherit", stdout: "pipe", stderr: "inherit", env: Bun.env });
    const result = z.looseObject({ address: addressSchema }).parse(JSON.parse(await new Response(provision.stdout).text()));
    if (await provision.exited !== 0) throw new Error("Ledger Key Ring agent provisioning failed"); agentAddress = result.address;
  }
}
const config = configurationSchema.parse({
  apiUrl: Bun.env["AQUA_API_URL"] ?? "http://127.0.0.1:3000",
  rpcUrl: Bun.env["AQUA_RPC_URL"] ?? "http://127.0.0.1:8545",
  agent: agentAddress, signerProgram,
  previewCachePath: Bun.env["AQUA_PREVIEW_CACHE"] ?? `${stateRoot}/previews.json`,
  oauthCachePath: Bun.env["AQUA_OAUTH_CACHE"] ?? `${stateRoot}/oauth.json`,
  oauthCallbackPort: Number(Bun.env["AQUA_OAUTH_CALLBACK_PORT"] ?? "41739"),
});
const rpc = new JsonRpcClient(new URL(config.rpcUrl), localProfileDefaults.rpcTimeoutMs);
const bazanticEvidence = await discoverConfiguredAquaTools();
if (bazanticEvidence !== null) console.error(JSON.stringify({
  level: "info", component: "aqua-mcp", message: "Bazantic Aqua tool catalog verified",
  gatewaySlug: bazanticEvidence.gatewaySlug, mcpUrl: bazanticEvidence.mcpUrl,
  fingerprints: bazanticEvidence.fingerprints,
}));
const accessToken = await oauthAccessToken(config.apiUrl, config.oauthCachePath, config.oauthCallbackPort);

const signTypedData = async (typedData: Readonly<Record<string, unknown>>): Promise<`0x${string}`> => {
  const child = Bun.spawn([process.execPath, config.signerProgram, "sign-typed-data"], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: Bun.env });
  await child.stdin.write(JSON.stringify({ typedData })); await child.stdin.end();
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
const signTransaction = async (transaction: { readonly chainId: number; readonly nonce: bigint; readonly maxPriorityFeePerGas: bigint; readonly maxFeePerGas: bigint; readonly gas: bigint; readonly to: Address; readonly value: bigint; readonly data: Hex }): Promise<Hex> => {
  const child = Bun.spawn([process.execPath, config.signerProgram, "sign-transaction"], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: Bun.env });
  await child.stdin.write(JSON.stringify({ transaction: {
    ...transaction, nonce: transaction.nonce.toString(), maxPriorityFeePerGas: transaction.maxPriorityFeePerGas.toString(),
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
const executePrerequisites = async (preview: Readonly<Record<string, unknown>>): Promise<readonly Hash[]> => {
  const parsed = prerequisitesSchema.parse(preview["prerequisites"]); const hashes: Hash[] = [];
  for (const transaction of parsed.transactions) {
    if (transaction.from !== config.agent || transaction.chainId !== preview["chainId"]) throw new Error("Reviewed prerequisite transaction does not belong to the local agent and chain");
    const [nonce, gasPrice, priority] = await Promise.all([rpc.transactionCount(config.agent), rpc.gasPrice(), rpc.maxPriorityFeePerGas()]);
    const gas = transaction.gas === undefined ? await rpc.estimateGas({ from: config.agent, to: transaction.to, data: transaction.data, value: transaction.value }) : hexToQuantity(transaction.gas);
    const raw = await signTransaction({ chainId: transaction.chainId, nonce, maxPriorityFeePerGas: priority, maxFeePerGas: gasPrice * 2n + priority, gas, to: transaction.to, value: hexToQuantity(transaction.value), data: transaction.data });
    const hash = await rpc.sendRawTransaction(raw); hashes.push(hash); await waitForReceipt(hash);
  }
  return hashes;
};

const delegationContextSchema = z.object({
  owner: addressSchema,
  normalizedTrade: z.object({ sellToken: addressSchema }).loose(),
  tokens: z.object({ sell: z.object({ decimals: z.number().int().min(0).max(255) }).loose() }).loose(),
  execution: z.object({ fundingAmountUnits: z.string().regex(/^(?:0|[1-9][0-9]*)$/u) }).loose(),
}).loose();
const delegationPreviewSchema = z.object({ previewId: z.uuid(), previewHash: hashSchema, typedData: z.record(z.string(), z.unknown()) }).loose();
const delegationSubmissionSchema = z.object({ transactionHash: hashSchema }).loose();

const http = new PayingHttpClient({
  signer: {
    address: clientAddressSchema.parse(config.agent),
    signTypedData: (request) => signTypedData(request),
  },
});
const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${accessToken}`);
  return http.requestPlain(new URL(path, config.apiUrl), { ...init, headers });
};
const json = async (response: Response): Promise<unknown> => {
  const { body } = await parseHttpJson(response);
  if (!response.ok && response.status !== 402) throw new Error(`Aqua API ${String(response.status)}: ${JSON.stringify(body)}`);
  return body;
};
const output = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: typeof body === "object" && body !== null ? z.record(z.string(), z.unknown()).parse(body) : { result: body } });

const ensureDelegation = async (preview: Readonly<Record<string, unknown>>): Promise<Hash> => {
  const context = delegationContextSchema.parse(preview);
  const amount = formatTokenAmount(BigInt(context.execution.fundingAmountUnits), context.tokens.sell.decimals);
  const created = delegationPreviewSchema.parse(await json(await api("/v1/delegations/previews", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      agent: config.agent, token: context.normalizedTrade.sellToken, maxPerOrder: amount, maxPerDay: amount,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  })));
  const ownerSignature = await signLedgerTypedData(context.owner, created.typedData);
  const submitted = delegationSubmissionSchema.parse(await json(await api("/v1/delegations", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewId: created.previewId, previewHash: created.previewHash, ownerSignature }),
  })));
  await waitForReceipt(submitted.transactionHash); return submitted.transactionHash;
};

const ensureAgentBinding = async (): Promise<void> => {
  const challengeResponse = await api("/v1/agents/me/challenges", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: config.agent }),
  });
  const challenge = z.object({ challengeId: z.uuid(), typedData: z.record(z.string(), z.unknown()) }).loose().parse(await json(challengeResponse));
  const signature = await signTypedData(challenge.typedData);
  await json(await api("/v1/agents/me", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, agent: config.agent, signature }),
  }));
};

const loadCache = async (): Promise<Record<string, Readonly<Record<string, unknown>>>> => {
  try { return z.record(z.string(), z.record(z.string(), z.unknown())).parse(JSON.parse(await readFile(config.previewCachePath, "utf8"))); }
  catch { return {}; }
};
const savePreview = async (body: Readonly<Record<string, unknown>>): Promise<void> => {
  const id = z.uuid().parse(body["previewId"]); const cache = await loadCache(); cache[id] = body;
  await mkdir(dirname(config.previewCachePath), { recursive: true, mode: 0o700 });
  await writeFile(config.previewCachePath, JSON.stringify(cache), { mode: 0o600 });
};

const requestTrade = async (arguments_: unknown) => {
  const parsed = tradePreviewRequestSchema.parse(arguments_);
  const response = await api("/v1/trade-previews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed) });
  const body = await json(response); if (response.status === 201) await savePreview(z.record(z.string(), z.unknown()).parse(body)); return output(body);
};
const postTrade = async (arguments_: unknown) => {
  const { previewId, previewHash } = z.object({ previewId: z.uuid(), previewHash: hashSchema }).strict().parse(arguments_);
  const preview = (await loadCache())[previewId]; if (preview?.["previewHash"] !== previewHash) throw new Error("Reviewed preview is not present in the local cache");
  const lifecycle = z.record(z.string(), z.unknown()).parse(preview["lifecycle"]); const signature = await signTypedData(lifecycle);
  const body = JSON.stringify({ previewId, previewHash, lifecycleSignature: signature });
  const headers = new Headers({ "content-type": "application/json", "idempotency-key": previewId });
  headers.set("authorization", `Bearer ${accessToken}`);
  let validation = await api("/v1/trades", { method: "POST", headers, body });
  if (validation.status === 409) {
    const validationResult = await parseHttpJson(validation);
    const error = z.object({ type: z.string() }).loose().safeParse(validationResult.body);
    if (!error.success || error.data.type !== "urn:aqua:error:delegation-required") throw new Error(`Aqua API 409: ${JSON.stringify(validationResult.body)}`);
    await ensureDelegation(preview); validation = await api("/v1/trades", { method: "POST", headers, body });
  }
  if (validation.status !== 402) return output(await json(validation));
  const prerequisiteTransactionHashes = await executePrerequisites(preview);
  headers.set("aqua-prerequisite-transactions", Buffer.from(JSON.stringify(prerequisiteTransactionHashes)).toString("base64url"));
  const network = `eip155:${chainIdSchema.parse(preview["chainId"])}` as const;
  const response = await retryAquaPayment(http, validation, new URL("/v1/trades", config.apiUrl), { method: "POST", headers, body }, network);
  return output(await json(response));
};
const getTrades = async (arguments_: unknown) => {
  const parsed = tradesListQuerySchema.parse(arguments_);
  const query = new URLSearchParams(); for (const [key, value] of Object.entries(parsed)) if (value !== undefined) query.set(key, String(value));
  return output(await json(await api(`/v1/trades?${query.toString()}`)));
};
const subscription = async (arguments_: unknown, remove: boolean) => { const { address } = z.object({ address: addressSchema }).strict().parse(arguments_); return output(await json(await api(remove ? `/v1/trade-subscriptions/${address}` : "/v1/trade-subscriptions", remove ? { method: "DELETE" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) }))); };
const wipe = async (arguments_: unknown) => { const parsed = subscribedTradesWipeSchema.parse(arguments_); return output(await json(await api("/v1/trade-subscriptions/trades/wipe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed) }))); };

const schema = (value: z.ZodType): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(z.toJSONSchema(value, { target: "draft-2020-12", io: "input" }));
const tools = [
  { name: "request_trade", description: "Resolve, quote, fully describe, and simulate an immutable trade before signing.", inputSchema: schema(tradePreviewRequestSchema) },
  { name: "post_trade", description: "Sign the reviewed lifecycle plan locally, satisfy its exact x402 Permit2 funding request, and submit it.", inputSchema: schema(z.object({ previewId: z.uuid(), previewHash: hashSchema }).strict()) },
  { name: "get_trades", description: "Read own, subscribed, or combined trade records with stable filtering and sorting.", inputSchema: schema(tradesListQuerySchema) },
  { name: "subscribe_to_user", description: "Subscribe to confirmed trades for an EVM address.", inputSchema: schema(z.object({ address: addressSchema }).strict()) },
  { name: "unsubscribe_from_user", description: "Stop collecting trades for an address without deleting its stored records.", inputSchema: schema(z.object({ address: addressSchema }).strict()) },
  { name: "wipe_subscribed_trades", description: "Delete stored subscribed-wallet trades for one address or all addresses; subscriptions remain active.", inputSchema: schema(subscribedTradesWipeSchema) },
] as const;
const server = new Server({ name: "aqua-ledger-key-ring", version: "1.0.0" }, { capabilities: { tools: {} } });
/* type-coverage:ignore-next-line -- request schema inference is untyped upstream across the Zod major-version boundary. */
server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools }));
/* type-coverage:ignore-next-line -- request schema inference is untyped upstream across the Zod major-version boundary. */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const arguments_: unknown = request.params.arguments ?? {};
  if (request.params.name === "request_trade") return requestTrade(arguments_);
  if (request.params.name === "post_trade") return postTrade(arguments_);
  if (request.params.name === "get_trades") return getTrades(arguments_);
  if (request.params.name === "subscribe_to_user") return subscription(arguments_, false);
  if (request.params.name === "unsubscribe_from_user") return subscription(arguments_, true);
  if (request.params.name === "wipe_subscribed_trades") return wipe(arguments_);
  throw new Error("Unknown tool");
});
await ensureAgentBinding();
await server.connect(new StdioServerTransport());
