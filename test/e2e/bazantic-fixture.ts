import { readFile } from "node:fs/promises";
import { z } from "zod";

const keyPath = Bun.env["AQUA_BAZANTIC_FIXTURE_KEY"];
const certPath = Bun.env["AQUA_BAZANTIC_FIXTURE_CERT"];
const ready = Bun.env["AQUA_BAZANTIC_FIXTURE_READY"];
const port = Number(Bun.env["AQUA_BAZANTIC_FIXTURE_PORT"] ?? "19443");
if (keyPath === undefined || certPath === undefined || ready === undefined) throw new Error("Bazantic fixture environment is incomplete");

const tools = [
  ["requestTrade", ["sellToken", "buyToken", "amount"]],
  ["postTrade", ["previewId", "previewHash"]],
  ["getTrades", []],
  ["cancelTrade", ["tradeId"]],
  ["subscribeToUser", ["address"]],
  ["unsubscribeFromUser", ["address"]],
  ["wipeSubscribedTrades", ["scope"]],
] as const;
const rpcBodySchema = z.object({
  id: z.unknown().optional(),
  method: z.unknown().optional(),
  params: z.object({ name: z.unknown().optional() }).loose().optional(),
}).loose();
let catalogRequests = 0;
let listRequests = 0;
let paidRequests = 0;
const sse = (value: unknown): Response => new Response(`event: message\ndata: ${JSON.stringify(value)}\n\n`, {
  headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  tls: { key: await readFile(keyPath), cert: await readFile(certPath) },
  fetch: async (request) => {
    const url = new URL(request.url);
    if (new Headers(request.headers).has("payment-signature")) paidRequests += 1;
    if (url.pathname === "/evidence") return Response.json({ catalogRequests, listRequests, paidRequests });
    const body = rpcBodySchema.parse(JSON.parse(await request.text()));
    if (url.pathname === "/catalog" && body.method === "tools/call" && body.params?.name === "get_gateway") {
      catalogRequests += 1;
      return sse({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: { found: true, gateway: {
        name: "Aqua local E2E", description: "Protocol-only fixture", tags: ["aqua"],
        url: `https://127.0.0.1:${String(port)}/provider`, mcp: `https://127.0.0.1:${String(port)}/gateway`,
      } } } });
    }
    if (url.pathname === "/gateway" && body.method === "tools/list") {
      listRequests += 1;
      return sse({ jsonrpc: "2.0", id: body.id, result: { tools: tools.map(([name, required]) => ({
        name, description: name, inputSchema: { type: "object", required, properties: Object.fromEntries(required.map((key) => [key, {}])) },
      })) } });
    }
    return new Response("not found", { status: 404 });
  },
});
await Bun.write(ready, `${server.url.toString()}\n`);
console.error(JSON.stringify({ level: "info", component: "bazantic-e2e-fixture", url: server.url.toString() }));
