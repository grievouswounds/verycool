import { JSONRPC_PAYMENT_REQUIRED_CODE, MCP_PAYMENT_META_KEY } from "@aqua/x402-adapter";
import { parseStrictJson } from "@aqua/core";
import { z } from "zod";

const ready = Bun.env["AQUA_X402_FIXTURE_READY"];
const port = Number(Bun.env["AQUA_X402_FIXTURE_PORT"] ?? "19443");
if (ready === undefined) throw new Error("x402 MCP fixture environment is incomplete");

const challenge = {
  x402Version: 2,
  error: "Payment is required before trade activation",
  resource: { url: `http://127.0.0.1:${String(port)}/mcp`, description: "fixture" },
  accepts: [{
    scheme: "exact", network: "eip155:31337",
    asset: "0x3333333333333333333333333333333333333333", amount: "1",
    payTo: "0x4444444444444444444444444444444444444444", maxTimeoutSeconds: 60,
    extra: { assetTransferMethod: "permit2", paymentFlow: "upfront" },
  }],
};
const rpcBodySchema = z.object({
  id: z.unknown().optional(),
  method: z.unknown().optional(),
  params: z.object({
    name: z.unknown().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  }).loose().optional(),
}).loose();
let challenges = 0;
let settlements = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/evidence") return Response.json({ challenges, settlements });
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    const body = rpcBodySchema.parse(parseStrictJson(await request.text()));
    if (body.method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "post_trade", inputSchema: { type: "object" } }] } });
    }
    if (body.method === "tools/call" && body.params?.name === "post_trade") {
      const paid = body.params._meta?.[MCP_PAYMENT_META_KEY];
      if (paid === undefined) {
        challenges += 1;
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          error: { code: JSONRPC_PAYMENT_REQUIRED_CODE, message: "Payment required", data: challenge },
        });
      }
      settlements += 1;
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "{\"ok\":true}" }] } });
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  },
});
await Bun.write(ready, `${server.url.toString()}\n`);
console.error(JSON.stringify({ level: "info", component: "x402-mcp-fixture", url: server.url.toString() }));
