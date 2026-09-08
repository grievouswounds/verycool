import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { parseStrictJson } from "@aqua/core";
import { z } from "zod";

export const BAZANTIC_CATALOG_MCP_URL = "https://bazgateway.com/mcp/";
export const BASE_NETWORK = "eip155:8453" as const;
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const DEFAULT_BAZANTIC_MAX_AMOUNT = "10000";
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type HexAddress = `0x${string}`;
type HexSignature = `0x${string}`;

export type TypedDataRequest = Readonly<Record<string, unknown>> & {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, unknown>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
};

export interface X402Signer {
  readonly address: HexAddress;
  signTypedData(request: TypedDataRequest): Promise<HexSignature>;
}

const absoluteHttpsUrlSchema = z.url().refine((value) => new URL(value).protocol === "https:", "expected an HTTPS URL");
const optionalUrlSchema = absoluteHttpsUrlSchema.optional();
const gatewayDetailsSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).nullable().optional(),
  url: absoluteHttpsUrlSchema,
  mcp: optionalUrlSchema,
  agentCard: optionalUrlSchema,
  specification: optionalUrlSchema,
  documentation: optionalUrlSchema,
  home: optionalUrlSchema,
}).strict();

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u);
const gatewayRowsSchema = z.record(slugSchema, gatewayDetailsSchema);
const contentSchema = z.array(z.object({ type: z.literal("text"), text: z.string() }).strict());
const rpcIdSchema = z.union([z.string(), z.number().int()]);
const rpcEnvelopeSchema = z.object({ jsonrpc: z.literal("2.0"), id: rpcIdSchema, result: z.unknown() }).strict();
const listResultSchema = z.object({ content: contentSchema, structuredContent: gatewayRowsSchema }).strict();
const getResultSchema = z.object({
  content: contentSchema,
  structuredContent: z.object({ found: z.boolean(), gateway: gatewayDetailsSchema.nullable().optional() }).strict(),
}).strict();
const searchResultSchema = z.object({
  content: contentSchema,
  structuredContent: z.object({
    results: z.array(z.object({ type: z.literal("gateway"), score: z.number(), gateway: gatewayDetailsSchema.nullable() }).strict()).nullable(),
  }).strict(),
}).strict();

const gatewayBrand = new WeakSet<object>();

export interface BazanticGateway {
  readonly slug: string | null;
  readonly name: string;
  readonly description: string;
  readonly endpointUrl: string;
  readonly mcpUrl: string | null;
  readonly tags: readonly string[];
}

const issueGateway = (slug: string | null, details: z.infer<typeof gatewayDetailsSchema>): BazanticGateway => {
  const gateway: BazanticGateway = Object.freeze({
    slug,
    name: details.name,
    description: details.description,
    endpointUrl: details.url,
    mcpUrl: details.mcp ?? null,
    tags: Object.freeze([...(details.tags ?? [])]),
  });
  gatewayBrand.add(gateway);
  return gateway;
};

const assertIssuedGateway = (gateway: BazanticGateway): void => {
  if (!gatewayBrand.has(gateway)) throw new Error("Bazantic gateway was not issued by the catalog client");
};

const responseBytes = async (response: Response, maximum: number): Promise<Uint8Array> => {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/u.test(length) || BigInt(length) > BigInt(maximum))) {
    throw new Error("HTTP response exceeds the configured byte limit");
  }
  const body = response.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let reading = true;
  while (reading) {
    const item = await reader.read();
    if (item.done) reading = false;
    else {
      size += item.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("HTTP response exceeds the configured byte limit");
      }
      chunks.push(item.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
};

export const readBoundedText = async (response: Response, maximum = DEFAULT_MAX_RESPONSE_BYTES): Promise<string> =>
  new TextDecoder("utf-8", { fatal: true }).decode(await responseBytes(response, maximum));

export const readBoundedJson = async (response: Response, maximum = DEFAULT_MAX_RESPONSE_BYTES): Promise<unknown> =>
  parseStrictJson(await readBoundedText(response, maximum));

export const parseSseJson = (text: string): unknown[] => {
  const messages: unknown[] = [];
  for (const rawFrame of text.replaceAll("\r\n", "\n").split("\n\n")) {
    if (rawFrame.trim() === "") continue;
    let event = "message";
    const data: string[] = [];
    for (const line of rawFrame.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const rawValue = separator === -1 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field !== "id" && field !== "retry") throw new Error(`Unsupported SSE field: ${field}`);
    }
    if (event !== "message") continue;
    if (data.length === 0) throw new Error("MCP message event is missing data");
    messages.push(parseStrictJson(data.join("\n")));
  }
  return messages;
};

const boundedFetch = async (fetch_: Fetch, input: string | URL | Request, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal === null || init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout]);
  return fetch_(input, { ...init, signal });
};

const rpcMessage = async (fetch_: Fetch, url: string, body: Readonly<Record<string, unknown>>, maximum: number, timeoutMs: number): Promise<unknown> => {
  const response = await boundedFetch(fetch_, url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!response.ok) throw new Error(`MCP request failed with HTTP ${String(response.status)}`);
  const text = await readBoundedText(response, maximum);
  const contentType = response.headers.get("content-type") ?? "";
  const values = contentType.includes("text/event-stream") || text.startsWith("event:") ? parseSseJson(text) : [parseStrictJson(text)];
  if (values.length !== 1) throw new Error("Expected exactly one MCP JSON-RPC response");
  return values[0];
};

export interface BazanticCatalogOptions {
  readonly fetch?: Fetch;
  readonly url?: string;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

export class BazanticCatalogClient {
  readonly #fetch: Fetch;
  readonly #url: string;
  readonly #maximum: number;
  readonly #timeoutMs: number;
  #id = 0;

  constructor(options: BazanticCatalogOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#url = absoluteHttpsUrlSchema.parse(options.url ?? BAZANTIC_CATALOG_MCP_URL);
    this.#maximum = z.number().int().positive().parse(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    this.#timeoutMs = z.number().int().positive().parse(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async #call(name: "list_gateways" | "get_gateway" | "search", arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.#id += 1;
    return rpcMessage(this.#fetch, this.#url, {
      jsonrpc: "2.0", id: this.#id, method: "tools/call", params: { name, arguments: arguments_ },
    }, this.#maximum, this.#timeoutMs);
  }

  async listGateways(): Promise<readonly BazanticGateway[]> {
    const envelope = rpcEnvelopeSchema.parse(await this.#call("list_gateways", {}));
    const result = listResultSchema.parse(envelope.result);
    return Object.entries(result.structuredContent).map(([slug, details]) => issueGateway(slug, details));
  }

  async getGateway(slug: string): Promise<BazanticGateway | null> {
    const parsedSlug = slugSchema.parse(slug);
    const envelope = rpcEnvelopeSchema.parse(await this.#call("get_gateway", { slug: parsedSlug }));
    const result = getResultSchema.parse(envelope.result).structuredContent;
    if (!result.found) return null;
    if (result.gateway === null || result.gateway === undefined) throw new Error("Bazantic catalog marked gateway found without details");
    return issueGateway(parsedSlug, result.gateway);
  }

  async search(query: string): Promise<readonly BazanticGateway[]> {
    const q = z.string().max(512).parse(query);
    const envelope = rpcEnvelopeSchema.parse(await this.#call("search", { q }));
    const results = searchResultSchema.parse(envelope.result).structuredContent.results ?? [];
    return results.flatMap((result) => result.gateway === null ? [] : [issueGateway(null, result.gateway)]);
  }
}

const toolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
}).loose();
const toolsEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"), id: rpcIdSchema,
  result: z.object({ tools: z.array(toolSchema) }).loose(),
}).strict();

export interface GatewayTool {
  readonly name: string;
  readonly description: string | null;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export const discoverGatewayTools = async (
  gateway: BazanticGateway,
  options: Pick<BazanticCatalogOptions, "fetch" | "maxResponseBytes" | "timeoutMs"> = {},
): Promise<readonly GatewayTool[] | null> => {
  assertIssuedGateway(gateway);
  if (gateway.mcpUrl === null) return null;
  const fetch_ = options.fetch ?? globalThis.fetch;
  const maximum = z.number().int().positive().parse(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
  const timeoutMs = z.number().int().positive().parse(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const response = await boundedFetch(fetch_, gateway.mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }, timeoutMs);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Gateway MCP discovery failed with HTTP ${String(response.status)}`);
  const messages = parseSseJson(await readBoundedText(response, maximum));
  if (messages.length !== 1) throw new Error("Expected exactly one gateway MCP response");
  const tools = toolsEnvelopeSchema.parse(messages[0]).result.tools;
  return tools.map((tool) => ({ name: tool.name, description: tool.description ?? null, inputSchema: tool.inputSchema }));
};

export type PaymentPolicy =
  | { readonly kind: "aqua"; readonly network: `eip155:${string}` }
  | { readonly kind: "bazantic"; readonly maxAmount: string };

export interface PaymentHeaderFactory {
  create(required: PaymentRequired, policy: PaymentPolicy): Promise<Readonly<Record<string, string>>>;
}

const atomicAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u);
const evmAddressSchema = z.custom<HexAddress>((value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value));

const requirementsForPolicy = (requirements: PaymentRequirements[], policy: PaymentPolicy): PaymentRequirements[] => {
  if (policy.kind === "aqua") {
    return requirements.filter((item) => item.network === policy.network && item.scheme === "exact" &&
      item.extra["assetTransferMethod"] === "permit2" && item.extra["paymentFlow"] === "upfront");
  }
  const maximum = BigInt(atomicAmountSchema.parse(policy.maxAmount));
  return requirements.filter((item) => item.network === BASE_NETWORK && item.scheme === "exact" &&
    item.asset.toLowerCase() === BASE_USDC && atomicAmountSchema.safeParse(item.amount).success && BigInt(item.amount) <= maximum);
};

export class LedgerX402PaymentHeaders implements PaymentHeaderFactory {
  readonly #signer: X402Signer;
  constructor(signer: X402Signer) { this.#signer = { ...signer, address: evmAddressSchema.parse(signer.address) }; }

  async create(required: PaymentRequired, policy: PaymentPolicy): Promise<Readonly<Record<string, string>>> {
    const client = new x402Client();
    const network = policy.kind === "aqua" ? policy.network : BASE_NETWORK;
    client.registerPolicy((_version, requirements) => {
      const allowed = requirementsForPolicy(requirements, policy);
      if (allowed.length === 0) throw new Error(`x402 challenge has no allowed ${policy.kind} payment requirement`);
      return allowed;
    });
    client.setSpendControls(policy.kind === "aqua" ? false : { maxAmountPerPayment: false });
    registerExactEvmScheme(client, { signer: this.#signer, networks: [network] });
    const http = new x402HTTPClient(client);
    return http.encodePaymentSignatureHeader(await http.createPaymentPayload(required));
  }
}

export interface PayingClientOptions {
  readonly signer?: X402Signer;
  readonly paymentHeaders?: PaymentHeaderFactory;
  readonly fetch?: Fetch;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

export class PayingHttpClient {
  readonly #fetch: Fetch;
  readonly #paymentHeaders: PaymentHeaderFactory;
  readonly #maximum: number;
  readonly #timeoutMs: number;

  constructor(options: PayingClientOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (options.paymentHeaders !== undefined) this.#paymentHeaders = options.paymentHeaders;
    else if (options.signer !== undefined) this.#paymentHeaders = new LedgerX402PaymentHeaders(options.signer);
    else throw new Error("PayingHttpClient requires a signer or payment header factory");
    this.#maximum = z.number().int().positive().parse(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    this.#timeoutMs = z.number().int().positive().parse(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async requestPlain(url: URL, init: RequestInit = {}): Promise<Response> {
    return boundedFetch(this.#fetch, url, init, this.#timeoutMs);
  }

  async retryPayment(requiredResponse: Response, url: URL, init: RequestInit, policy: PaymentPolicy): Promise<Response> {
    if (requiredResponse.status !== 402) throw new Error("Payment retry requires an HTTP 402 response");
    const http = new x402HTTPClient(new x402Client());
    const requiredHeader = requiredResponse.headers.get("payment-required") ?? requiredResponse.headers.get("x-payment-required");
    const body = requiredHeader === null ? await readBoundedJson(requiredResponse.clone(), this.#maximum) : undefined;
    const required = http.getPaymentRequiredResponse((name) => requiredResponse.headers.get(name), body);
    const paymentHeaders = await this.#paymentHeaders.create(required, policy);
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(paymentHeaders)) headers.set(name, value);
    return boundedFetch(this.#fetch, url, { ...init, headers }, this.#timeoutMs);
  }

  async request(url: URL, init: RequestInit, policy: PaymentPolicy): Promise<Response> {
    const first = await boundedFetch(this.#fetch, url, init, this.#timeoutMs);
    return first.status === 402 ? this.retryPayment(first, url, init, policy) : first;
  }

  async requestAqua(url: URL, init: RequestInit, network: `eip155:${string}`): Promise<Response> {
    return this.request(url, init, { kind: "aqua", network });
  }

  async retryAqua(requiredResponse: Response, url: URL, init: RequestInit, network: `eip155:${string}`): Promise<Response> {
    return this.retryPayment(requiredResponse, url, init, { kind: "aqua", network });
  }

  async requestGateway(gateway: BazanticGateway, path: string, init: RequestInit, maxAmount = DEFAULT_BAZANTIC_MAX_AMOUNT): Promise<Response> {
    assertIssuedGateway(gateway);
    if (path.includes("\\") || path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(path)) throw new Error("Gateway path must be a relative provider path");
    const base = gateway.endpointUrl.endsWith("/") ? gateway.endpointUrl : `${gateway.endpointUrl}/`;
    const url = new URL(path.replace(/^\/+/, ""), base);
    if (url.origin !== new URL(gateway.endpointUrl).origin || url.username !== "" || url.password !== "") throw new Error("Gateway path escaped its catalog endpoint");
    return this.request(url, init, { kind: "bazantic", maxAmount: atomicAmountSchema.parse(maxAmount) });
  }
}

export interface ParsedHttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

export const parseHttpJson = async (response: Response, maximum = DEFAULT_MAX_RESPONSE_BYTES): Promise<ParsedHttpResponse> => ({
  status: response.status,
  body: await readBoundedJson(response, maximum),
  headers: response.headers,
});
