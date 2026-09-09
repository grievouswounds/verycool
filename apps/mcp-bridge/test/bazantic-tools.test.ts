import { describe, expect, test } from "bun:test";
import { discoverAquaTools, schemaFingerprint } from "../src/bazantic-tools.ts";

const catalogUrl = "https://catalog.e2e.invalid/mcp/";
const gatewayUrl = "https://aqua.e2e.invalid/mcp";
const aliases = ["requestTrade", "postTrade", "getTrades", "subscribeToUser", "unsubscribeFromUser", "wipeSubscribedTrades"];
const sse = (value: unknown): Response => new Response(`event: message\ndata: ${JSON.stringify(value)}\n\n`, {
  headers: { "content-type": "text/event-stream" },
});

const routedFetch = (toolNames: readonly string[] = aliases) => async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const request = JSON.parse(String(init?.body)) as { readonly method: string; readonly params?: { readonly name?: string } };
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
      "get_trades", "post_trade", "request_trade", "subscribe_to_user", "unsubscribe_from_user", "wipe_subscribed_trades",
    ]);
    expect(new Set(Object.values(result.fingerprints)).size).toBe(1);
  });

  test("fails closed when the generated gateway omits a required operation", async () => {
    await expect(discoverAquaTools({ gatewaySlug: "aqua", catalogUrl, fetch: routedFetch(aliases.slice(0, -1)) }))
      .rejects.toThrow("missing required operation wipe_subscribed_trades");
  });

  test("schema fingerprints are stable across object key order", () => {
    expect(schemaFingerprint({ type: "object", properties: { a: { type: "string" } } }))
      .toBe(schemaFingerprint({ properties: { a: { type: "string" } }, type: "object" }));
  });
});
