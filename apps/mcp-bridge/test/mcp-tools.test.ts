import { describe, expect, test } from "bun:test";
import { discoverAquaTools, schemaFingerprint } from "../src/mcp-tools.ts";

const mcpUrl = "https://aqua.example/mcp";
const names = ["request_trade", "post_trade", "get_trades", "cancel_trade", "subscribe_to_user", "unsubscribe_from_user", "wipe_subscribed_trades"];

describe("hosted Aqua MCP catalog", () => {
  test("fingerprints all required operations without payment", async () => {
    const result = await discoverAquaTools({
      mcpUrl,
      fetch: () => Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: { tools: names.map((name) => ({
        name, inputSchema: { type: "object", properties: { previewId: { type: "string" } } },
      })) } })),
    });
    expect(result.mcpUrl).toBe(mcpUrl);
    expect(Object.keys(result.fingerprints).sort()).toEqual([...names].sort());
    expect(new Set(Object.values(result.fingerprints)).size).toBe(1);
  });

  test("fails closed when the origin omits a required operation", async () => {
    await expect(discoverAquaTools({
      mcpUrl,
      fetch: () => Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: { tools: names.slice(0, -1).map((name) => ({
        name, inputSchema: { type: "object" },
      })) } })),
    })).rejects.toThrow(/missing required operation wipe_subscribed_trades/);
  });

  test("schema fingerprints are stable across object key order", () => {
    expect(schemaFingerprint({ type: "object", properties: { a: { type: "string" } } }))
      .toBe(schemaFingerprint({ properties: { a: { type: "string" } }, type: "object" }));
  });
});
