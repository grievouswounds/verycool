import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { discoverAquaTools, schemaFingerprint } from "../src/bazantic-tools.ts";

const catalogUrl = "https://catalog.e2e.invalid/mcp/";
const gatewayUrl = "https://aqua.e2e.invalid/mcp";
const aliases = ["requestTrade", "postTrade", "getTrades", "cancelTrade", "subscribeToUser", "unsubscribeFromUser", "wipeSubscribedTrades"];
const rpcBodySchema = z.object({
  method: z.string(),
  params: z.object({ name: z.string().optional() }).loose().optional(),
}).loose();
const sse = (value: unknown): Response => new Response(`event: message\ndata: ${JSON.stringify(value)}\n\n`, {
  headers: { "content-type": "text/event-stream" },
});

const requestBody = (init: RequestInit | undefined): string => {
  const body = init?.body;
  if (typeof body === "string") return body;
  throw new Error("test fetcher expected a JSON string body");
};

const routedFetch = (toolNames: readonly string[] = aliases) => async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const request = rpcBodySchema.parse(JSON.parse(requestBody(init)));
  if (url === catalogUrl) {
    expect(request.method).toBe("tools/call");
    expect(request.params?.name).toBe("get_gateway");
    return sse({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { found: true, gateway: {
      name: "Aqua", description: "Aqua test gateway", url: "https://aqua.e2e.invalid/", mcp: gatewayUrl, tags: ["aqua"],
    } } } });
  }
  expect(url).toBe(gatewayUrl);
  expect(request.method).toBe("tools/list");
  expect(new Headers(init?.headers).has("payment-signature")).toBe(false);
  return sse({ jsonrpc: "2.0", id: 1, result: { tools: toolNames.map((name) => ({
    name, description: `${name} operation`, inputSchema: { type: "object", properties: { previewId: { type: "string" } } },
  })) } });
};

describe("Bazantic-backed Aqua MCP catalog", () => {
  test("resolves the catalog-issued MCP URL and fingerprints all required operations without payment", async () => {
    const result = await discoverAquaTools({ gatewaySlug: "aqua", catalogUrl, fetch: routedFetch() });
    expect(result.gatewaySlug).toBe("aqua");
    expect(result.mcpUrl).toBe(gatewayUrl);
    expect(Object.keys(result.fingerprints).sort()).toEqual([
      "cancel_trade", "get_trades", "post_trade", "request_trade", "subscribe_to_user", "unsubscribe_from_user", "wipe_subscribed_trades",
    ]);
    expect(new Set(Object.values(result.fingerprints)).size).toBe(1);
  });

  test("accepts createTradeCancellation as the cancel_trade catalog operation", async () => {
    const names = aliases.map((name) => name === "cancelTrade" ? "createTradeCancellation" : name);
    const result = await discoverAquaTools({ gatewaySlug: "aqua", catalogUrl, fetch: routedFetch(names) });
    expect(result.fingerprints.cancel_trade).toHaveLength(64);
  });

  test("fails closed when the generated gateway omits a required operation", async () => {
    try {
      await discoverAquaTools({ gatewaySlug: "aqua", catalogUrl, fetch: routedFetch(aliases.slice(0, -1)) });
      throw new Error("expected missing required operation");
    } catch (error: unknown) {
      expect(error instanceof Error ? error.message : "").toContain("missing required operation wipe_subscribed_trades");
    }
  });

  test("schema fingerprints are stable across object key order", () => {
    expect(schemaFingerprint({ type: "object", properties: { a: { type: "string" } } }))
      .toBe(schemaFingerprint({ properties: { a: { type: "string" } }, type: "object" }));
  });
});
