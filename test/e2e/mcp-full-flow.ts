import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { runTradeScenarios } from "./trade-scenarios.ts";

const bridge = Bun.env["AQUA_MCP_BRIDGE"];
const outputPath = Bun.env["AQUA_E2E_REPORT"];
if (bridge === undefined || outputPath === undefined) throw new Error("MCP E2E environment is incomplete");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bridge],
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
});
const client = new Client({ name: "aqua-e2e-official-sdk-client", version: "1.0.0" }, { capabilities: {} });
const transcript: { readonly method: string; readonly name?: string; readonly isError?: boolean }[] = [];
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  transcript.push({ method: "tools/call", name, isError: result.isError === true });
  const parsedContent = z.array(z.object({ text: z.string().optional() }).loose()).safeParse(result.content);
  const text = parsedContent.success ? parsedContent.data.map((item) => item.text ?? "").join("\n") : "";
  if (result.isError === true) throw new Error(`${name} returned an MCP tool error: ${text}`);
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
};

try {
  await client.connect(transport, { timeout: 300_000 });
  transcript.push({ method: "initialize" });
  const listed = await client.listTools();
  transcript.push({ method: "tools/list" });
  const names = listed.tools.map(({ name }) => name).sort();
  const required = ["cancel_trade", "get_trades", "post_trade", "request_trade", "subscribe_to_user", "unsubscribe_from_user", "wipe_subscribed_trades"];
  if (JSON.stringify(names) !== JSON.stringify(required)) throw new Error(`Unexpected MCP tools: ${names.join(",")}`);
  const scenarios = await runTradeScenarios(call);
  await call("subscribe_to_user", { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
  await call("get_trades", { source: "all", sort: "occurredAt", direction: "desc", limit: "50" });
  await call("wipe_subscribed_trades", { scope: "address", address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
  await call("unsubscribe_from_user", { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify({
    client: "@modelcontextprotocol/sdk", initialized: true, gracefulShutdown: true,
    negotiatedTools: names, scenarios, transcript,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
