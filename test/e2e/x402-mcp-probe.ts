import { JSONRPC_PAYMENT_REQUIRED_CODE, MCP_PAYMENT_META_KEY } from "@aqua/x402-adapter";
import { parseStrictJson } from "@aqua/core";
import { z } from "zod";

const port = Bun.env["AQUA_X402_FIXTURE_PORT"] ?? "19443";
const mcpUrl = `http://127.0.0.1:${port}/mcp`;
const rpcSchema = z.object({
  error: z.object({ code: z.number(), data: z.unknown() }).loose().optional(),
  result: z.unknown().optional(),
}).loose();
const evidenceSchema = z.object({ challenges: z.number(), settlements: z.number() }).strict();
const call = async (meta?: Readonly<Record<string, unknown>>): Promise<z.infer<typeof rpcSchema>> => {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "post_trade", arguments: {}, ...(meta === undefined ? {} : { _meta: meta }) },
    }),
  });
  return rpcSchema.parse(parseStrictJson(await response.text()));
};
const unpaid = await call();
if (unpaid.error?.code !== JSONRPC_PAYMENT_REQUIRED_CODE) throw new Error("expected -32042 payment challenge");
if (unpaid.error.data === undefined) throw new Error("expected PaymentRequired data");
const paid = await call({ [MCP_PAYMENT_META_KEY]: { x402Version: 2 } });
if (paid.result === undefined) throw new Error("expected settlement result");
const evidence = evidenceSchema.parse(parseStrictJson(await (await fetch(`http://127.0.0.1:${port}/evidence`)).text()));
if (evidence.challenges < 1 || evidence.settlements < 1) throw new Error("fixture did not record challenge and settlement");
console.log(JSON.stringify({ ok: true, ...evidence }));
