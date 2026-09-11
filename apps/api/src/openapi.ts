import { z } from "zod";
import {
  activityListQuerySchema, activityWipeSchema, agentBindingRequestSchema, agentChallengeRequestSchema, challengeRequestSchema, delegationPreviewRequestSchema, delegationSubmitRequestSchema, sessionRequestSchema, subscribedTradesWipeSchema, subscriptionRequestSchema, tradeCancellationSubmitRequestSchema, tradePreviewRequestSchema, tradeSubmitRequestSchema, tradingRequestSchema,
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
    description: "Ledger Key Ring trading API. Immutable trade previews are submitted through x402 exact Permit2 funding. The legacy /v1/trading command endpoint remains available for advanced REST workflows; MCP runs only as a local stdio bridge.",
  },
  tags: [
    { name: "discovery", description: "Machine-readable capability and health discovery" },
    { name: "authentication", description: "SIWE session lifecycle" },
    { name: "trading", description: "One discriminated command/query surface for orders, execution, market data, and wrapped native assets" },
    { name: "trade-lifecycle", description: "Two-phase immutable preview, delegated approval, x402 funding, and trade feeds" },
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
      TradePreviewRequest: schemaOf(tradePreviewRequestSchema),
      TradeSubmitRequest: schemaOf(tradeSubmitRequestSchema),
      TradeCancellationSubmitRequest: schemaOf(tradeCancellationSubmitRequestSchema),
      AgentChallengeRequest: schemaOf(agentChallengeRequestSchema),
      AgentBindingRequest: schemaOf(agentBindingRequestSchema),
      DelegationPreviewRequest: schemaOf(delegationPreviewRequestSchema),
      DelegationSubmitRequest: schemaOf(delegationSubmitRequestSchema),
      SubscribedTradesWipeRequest: schemaOf(subscribedTradesWipeSchema),
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
    "/v1/agents/me/challenges": { post: operation("createAgentBindingChallenge", "Create an EIP-712 proof-of-possession challenge for the local LKRP agent", "AgentChallengeRequest", true, "trade-lifecycle", { agent: "0x1111111111111111111111111111111111111111" }) },
    "/v1/agents/me": { put: operation("bindAgent", "Bind the locally encrypted agent to the Ledger owner", "AgentBindingRequest", true, "trade-lifecycle", { challengeId: "00000000-0000-4000-8000-000000000000", agent: "0x1111111111111111111111111111111111111111", signature: `0x${"00".repeat(65)}` }) },
    "/v1/delegations/previews": { post: operation("previewDelegation", "Prepare a bounded Ledger-owner delegation", "DelegationPreviewRequest", true, "trade-lifecycle", { agent: "0x1111111111111111111111111111111111111111", token: "0x2222222222222222222222222222222222222222", maxPerOrder: "1", maxPerDay: "1", expiresAt: "2027-01-01T00:00:00Z" }) },
    "/v1/delegations": { post: operation("registerDelegation", "Relay a Ledger-signed bounded delegation", "DelegationSubmitRequest", true, "trade-lifecycle", { previewId: "00000000-0000-4000-8000-000000000000", previewHash: `0x${"00".repeat(32)}`, ownerSignature: `0x${"00".repeat(65)}` }) },
    "/v1/trade-previews": { post: operation("requestTrade", "Resolve, quote, classify, and simulate an immutable trade", "TradePreviewRequest", true, "trade-lifecycle", { sellToken: { type: "native" }, buyToken: { type: "search", query: "USDC" }, amount: { side: "sell", value: "1" }, policy: { kind: "market", slippageBps: "50", timeInForce: "ioc" } }) },
    "/v1/trades": {
      get: { ...securedReadOperation("getTrades", "Read own and/or subscribed trades with cursor pagination", "trade-lifecycle"), parameters: tradeQueryParameters() },
      post: { ...operation("postTrade", "Submit an exact reviewed preview; initial request returns x402 v2 PAYMENT-REQUIRED", "TradeSubmitRequest", true, "trade-lifecycle", { previewId: "00000000-0000-4000-8000-000000000000", previewHash: `0x${"00".repeat(32)}`, lifecycleSignature: `0x${"00".repeat(65)}` }), parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", format: "uuid" } }] },
    },
    "/v1/trades/{tradeId}/cancellations": { post: {
      operationId: "createTradeCancellation", tags: ["trade-lifecycle"], summary: "Create an agent-signed cancellation for a resting or armed trade",
      security: [{ bearerAuth: [] }], parameters: [{ name: "tradeId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: okResponse(),
    } },
    "/v1/trades/{tradeId}/cancellations/{cancellationId}": { put: {
      ...operation("submitTradeCancellation", "Relay the agent-signed cancellation", "TradeCancellationSubmitRequest", true, "trade-lifecycle", { signature: `0x${"00".repeat(65)}` }),
      parameters: [
        { name: "tradeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        { name: "cancellationId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
    } },
    "/v1/trade-subscriptions": { post: operation("subscribeToUser", "Subscribe to confirmed wallet trades", "ActivitySubscriptionRequest", true, "trade-lifecycle", { address: "0x1111111111111111111111111111111111111111" }) },
    "/v1/trade-subscriptions/{address}": { delete: { operationId: "unsubscribeFromUser", tags: ["trade-lifecycle"], summary: "Stop collecting a wallet without deleting stored trades", security: [{ bearerAuth: [] }], parameters: [{ name: "address", in: "path", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }], responses: okResponse() } },
    "/v1/trade-subscriptions/trades/wipe": { post: operation("wipeSubscribedTrades", "Delete subscribed trade projections without removing subscriptions", "SubscribedTradesWipeRequest", true, "trade-lifecycle", { scope: "address", address: "0x1111111111111111111111111111111111111111" }) },
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

function tradeQueryParameters(): readonly Readonly<Record<string, unknown>>[] {
  return [
    { name: "source", in: "query", schema: { type: "string", enum: ["own", "subscriptions", "all"], default: "own" } },
    { name: "status", in: "query", schema: { type: "string" } }, { name: "address", in: "query", schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } },
    { name: "token", in: "query", schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }, { name: "kind", in: "query", schema: { type: "string" } },
    { name: "from", in: "query", schema: { type: "string", format: "date-time" } }, { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
    { name: "sort", in: "query", schema: { type: "string", enum: ["occurredAt", "updatedAt"], default: "occurredAt" } }, { name: "direction", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
    { name: "cursor", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
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

const openApiPaths = z.record(z.string(), z.unknown()).parse(openApiDocument["paths"]);

export const gatewayOpenApiDocument: Readonly<Record<string, unknown>> = {
  ...openApiDocument,
  info: {
    title: "Aqua hosted trade gateway",
    version: "1.0.0",
    description: "Sellable trade-lifecycle operations for Bazantic. Health, capabilities, and /v1/auth are intentionally omitted.",
  },
  paths: {
    "/v1/trade-previews": openApiPaths["/v1/trade-previews"],
    "/v1/trades": openApiPaths["/v1/trades"],
    "/v1/trades/{tradeId}/cancellations": openApiPaths["/v1/trades/{tradeId}/cancellations"],
    "/v1/trades/{tradeId}/cancellations/{cancellationId}": openApiPaths["/v1/trades/{tradeId}/cancellations/{cancellationId}"],
  },
};

export const docsHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Aqua API</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/docs/swagger-ui.js"></script><script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true,displayOperationId:true,filter:true,tryItOutEnabled:true})</script></body></html>`;

