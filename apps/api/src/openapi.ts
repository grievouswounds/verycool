import { z } from "zod";
import {
  activityListQuerySchema, activityWipeSchema, challengeRequestSchema, sessionRequestSchema, subscriptionRequestSchema, tradingRequestSchema,
} from "@aqua/core";
import { aquaQuoteRequestSchema } from "@aqua/quoter";

const schemaOf = (schema: z.ZodType): unknown => z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
const discriminatedSchemaOf = (schema: z.ZodType, propertyName: string): unknown => {
  const converted = schemaOf(schema);
  return typeof converted === "object" && converted !== null && !Array.isArray(converted)
    ? Object.assign({}, converted, { discriminator: { propertyName } }) : converted;
};

export const openApiDocument: Readonly<Record<string, unknown>> = {
  openapi: "3.1.0",
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {
    title: "Aqua transaction preparation API",
    version: "1.0.0",
    description: "Agent-first Aqua spot order-book API. POST /v1/trading is the only trading business endpoint. Every public number is a canonical decimal string and every transaction returned to an ordinary wallet is unsigned.",
  },
  tags: [
    { name: "discovery", description: "Machine-readable capability and health discovery" },
    { name: "authentication", description: "SIWE session lifecycle" },
    { name: "trading", description: "One discriminated command/query surface for orders, execution, market data, and wrapped native assets" },
    { name: "prices", description: "Authenticated 1inch token discovery and spot prices on the deployment chain" },
    { name: "quotes", description: "Authenticated read-only Aqua order simulation" },
    { name: "erc20-monitor", description: "Polling-based ERC-20 Transfer monitoring owned by the authenticated wallet" },
  ],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "PASETO v4.public" } },
    schemas: {
      TradingRequest: discriminatedSchemaOf(tradingRequestSchema, "action"),
      TradingResponse: {
        type: "object", additionalProperties: false, required: ["status", "nextActions"],
        properties: {
          action: { type: "string" }, chainId: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
          status: { type: "string", enum: ["ok", "accepted", "authorizationRequired"] },
          result: {}, authorizationId: { type: "string", format: "uuid" }, requirement: {},
          nextActions: { type: "array", maxItems: 8, items: { type: "string" } },
        },
      },
      Problem: {
        type: "object", additionalProperties: false, required: ["type", "title", "status", "detail", "requestId"],
        properties: {
          type: { type: "string" }, title: { type: "string" }, status: { type: "integer" }, detail: { type: "string" }, requestId: { type: "string" },
          issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["code", "path", "message"], properties: { code: { type: "string" }, path: { type: "string" }, message: { type: "string" } } } },
        },
      },
      ChallengeRequest: schemaOf(challengeRequestSchema),
      SessionRequest: schemaOf(sessionRequestSchema),
      ActivitySubscriptionRequest: schemaOf(subscriptionRequestSchema),
      ActivityListQuery: schemaOf(activityListQuerySchema),
      ActivityWipeRequest: schemaOf(activityWipeSchema),
      AquaQuoteRequest: schemaOf(aquaQuoteRequestSchema),
    },
  },
  paths: {
    "/health/live": { get: readOperation("getLiveness", "Process liveness", "discovery") },
    "/health/ready": { get: readOperation("getReadiness", "Dependency readiness", "discovery") },
    "/v1/capabilities": { get: readOperation("getCapabilities", "Discover accepted languages, order policies, and defaults", "discovery") },
    "/v1/auth/challenges": { post: operation("createAuthChallenge", "Create a one-time SIWE challenge", "ChallengeRequest", false, "authentication", { address: "0x1111111111111111111111111111111111111111" }) },
    "/v1/auth/sessions": { post: operation("createAuthSession", "Verify SIWE and create a session", "SessionRequest", false, "authentication", { challengeId: "00000000-0000-4000-8000-000000000000", message: "Use the exact challenge message", signature: `0x${"00".repeat(65)}` }) },
    "/v1/auth/refresh": { post: { operationId: "refreshAuthSession", tags: ["authentication"], summary: "Rotate the refresh token", responses: okResponse() } },
    "/v1/trading": { post: tradingOperation() },
    "/v1/prices/address/{address}": { get: priceOperation("getTokenPriceByAddress", "Look up a token spot price by address", "address") },
    "/v1/prices/name/{name}": { get: priceOperation("getTokenPriceByName", "Resolve a token name or symbol and look up its spot price", "name") },
    "/v1/quotes/aqua": { post: operation("quoteAquaOrder", "Quote one encoded Aqua order without preparing a transaction", "AquaQuoteRequest", true, "quotes", {
      encodedOrder: "0x", tokenIn: "0x1111111111111111111111111111111111111111", tokenOut: "0x2222222222222222222222222222222222222222", amountIn: "1",
    }) },
    "/v1/erc20-monitor/subscriptions": {
      get: securedReadOperation("listErc20MonitorSubscriptions", "List monitored addresses", "erc20-monitor"),
      post: operation("subscribeErc20Monitor", "Subscribe to confirmed ERC-20 activity", "ActivitySubscriptionRequest", true, "erc20-monitor", { address: "0x1111111111111111111111111111111111111111" }),
    },
    "/v1/erc20-monitor/subscriptions/{address}": { delete: {
      operationId: "unsubscribeErc20Monitor", tags: ["erc20-monitor"], summary: "Stop monitoring an address without deleting its data",
      security: [{ bearerAuth: [] }], parameters: [{ name: "address", in: "path", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }], responses: okResponse(),
    } },
    "/v1/erc20-monitor/actions": { get: {
      operationId: "listErc20Actions", tags: ["erc20-monitor"], summary: "List activity for one monitored address or all subscriptions",
      security: [{ bearerAuth: [] }], parameters: activityQueryParameters(), responses: okResponse(),
    } },
    "/v1/erc20-monitor/actions/wipe": { post: operation("wipeErc20Actions", "Delete collected activity for one address or all subscriptions", "ActivityWipeRequest", true, "erc20-monitor", { scope: "address", address: "0x1111111111111111111111111111111111111111" }) },
  },
};

function okResponse(): Readonly<Record<string, unknown>> {
  return { "200": { description: "Successful response" }, default: { description: "RFC 9457 problem response" } };
}

function tradingOperation(): Readonly<Record<string, unknown>> {
  return {
    operationId: "trade", tags: ["trading"], summary: "Create, amend, cancel, quote/prepare swaps, execute, batch, or query Aqua spot orders",
    description: "Use the action discriminator first, then provide only fields belonging to that action. Public order-book, ticker, recent-trade, candle, and fee queries do not require authentication; personal queries and mutations do. Conditional and linked orders return an aqua-intent-v1 HTTP 402 challenge until the agent retries with a valid AQUA-AUTHORIZATION header. Prices are quote-token units per one base token and all numbers are decimal strings.",
    security: [{}, { bearerAuth: [] }],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/TradingRequest" }, examples: {
        limitSell: { summary: "Minimal resting limit sell", value: { action: "createOrder", order: { kind: "limit", pair: { baseToken: "0x1111111111111111111111111111111111111111", quoteToken: "0x2222222222222222222222222222222222222222" }, side: "sell", size: { denomination: "base", amount: "1.5" }, limitPrice: "2500" } } },
        book: { summary: "Public order-book query", value: { action: "query", query: { resource: "orderBook", pair: { baseToken: "0x1111111111111111111111111111111111111111", quoteToken: "0x2222222222222222222222222222222222222222" } } } },
        stop: { summary: "Delegated stop-market order", value: { action: "createOrder", order: { kind: "stopMarket", pair: { baseToken: "0x1111111111111111111111111111111111111111", quoteToken: "0x2222222222222222222222222222222222222222" }, side: "sell", size: { denomination: "base", amount: "1" }, triggerPrice: "2000" } } },
      } } },
    },
    responses: {
      "200": { description: "Command prepared or query completed", content: { "application/json": { schema: { $ref: "#/components/schemas/TradingResponse" } } } },
      "202": { description: "Delegated intent accepted for asynchronous execution", content: { "application/json": { schema: { $ref: "#/components/schemas/TradingResponse" } } } },
      "402": { description: "aqua-intent-v1 signature required; this is not an x402 payment", headers: { "AQUA-AUTHORIZATION-REQUIRED": { schema: { type: "string", maxLength: 8192 } } }, content: { "application/json": { schema: { $ref: "#/components/schemas/TradingResponse" } } } },
      default: { description: "RFC 9457 problem", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
    },
    "x-agent-tool": { name: "aqua_trade", strict: true, guidance: "Choose exactly one action. Never calculate atomic token units; send human decimal strings." },
  };
}

function priceOperation(operationId: string, summary: string, parameter: "address" | "name"): Readonly<Record<string, unknown>> {
  return {
    operationId, summary, tags: ["prices"], security: [{ bearerAuth: [] }],
    parameters: [
      { name: parameter, in: "path", required: true, schema: parameter === "address"
        ? { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }
        : { type: "string", minLength: 1, maxLength: 64 } },
      { name: "currency", in: "query", required: false, schema: { type: "string", pattern: "^[A-Z]{3,8}$", default: "USD" } },
    ],
    responses: {
      "200": { description: "Spot price response with canonical decimal-string values" },
      "503": { description: "ONEINCH_API_KEY is not configured" },
      default: { description: "RFC 9457 problem response" },
    },
  };
}

function readOperation(operationId: string, summary: string, tag: string): Readonly<Record<string, unknown>> {
  return { operationId, summary, tags: [tag], responses: okResponse() };
}

function securedReadOperation(operationId: string, summary: string, tag: string): Readonly<Record<string, unknown>> {
  return { ...readOperation(operationId, summary, tag), security: [{ bearerAuth: [] }] };
}

function activityQueryParameters(): readonly Readonly<Record<string, unknown>>[] {
  return [
    { name: "address", in: "query", schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } },
    { name: "classification", in: "query", schema: { type: "string", enum: ["buy", "sell", "sent", "received", "minted", "burned", "selfTransfer"] } },
    { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
    { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
    { name: "cursor", in: "query", schema: { type: "string", pattern: "^[A-Za-z0-9_-]{1,512}$" } },
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
  ];
}

function operation(operationId: string, summary: string, schema: string, secured: boolean, tag: string, example: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    operationId, summary, tags: [tag],
    description: "Strict JSON object. Unknown properties, ambiguous alternatives, and non-canonical numeric strings are rejected.",
    ...(secured ? { security: [{ bearerAuth: [] }] } : {}),
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` }, examples: { agent: { summary: "Minimal agent request", value: example } } } },
    },
    responses: okResponse(),
  };
}

export const docsHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Aqua API</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/docs/swagger-ui.js"></script><script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true,displayOperationId:true,filter:true,tryItOutEnabled:true})</script></body></html>`;
