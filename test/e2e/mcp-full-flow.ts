import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addressSchema, hashSchema } from "@aqua/core";
import { z } from "zod";

const bridge = Bun.env["AQUA_MCP_BRIDGE"];
const manifestPath = Bun.env["AQUA_RUNTIME_MANIFEST"];
const outputPath = Bun.env["AQUA_E2E_REPORT"];
if (bridge === undefined || manifestPath === undefined || outputPath === undefined) throw new Error("MCP E2E environment is incomplete");
const manifest = z.object({ fixtures: z.object({ tokens: z.array(z.object({ address: addressSchema }).loose()).length(2) }) }).loose()
  .parse(JSON.parse(await readFile(manifestPath, "utf8")));
const first = manifest.fixtures.tokens[0]?.address;
const second = manifest.fixtures.tokens[1]?.address;
if (first === undefined || second === undefined) throw new Error("Two fixture tokens are required");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bridge],
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
});
const client = new Client({ name: "aqua-e2e-official-sdk-client", version: "1.0.0" }, { capabilities: {} });
const transcript: { readonly method: string; readonly name?: string; readonly isError?: boolean }[] = [];
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  transcript.push({ method: "tools/call", name, isError: result.isError === true });
  if (result.isError === true) throw new Error(`${name} returned an MCP tool error`);
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
};

try {
  await client.connect(transport);
  transcript.push({ method: "initialize" });
  const listed = await client.listTools();
  transcript.push({ method: "tools/list" });
  const names = listed.tools.map(({ name }) => name).sort();
  const required = ["get_trades", "post_trade", "request_trade", "subscribe_to_user", "unsubscribe_from_user", "wipe_subscribed_trades"];
  if (JSON.stringify(names) !== JSON.stringify(required)) throw new Error(`Unexpected MCP tools: ${names.join(",")}`);
  const previews: { readonly previewId: string; readonly previewHash: string }[] = [];
  for (const [sellToken, buyToken] of [[first, second], [second, first]] as const) {
    const preview = await call("request_trade", {
      sellToken: { type: "address", address: sellToken }, buyToken: { type: "address", address: buyToken },
      amount: { side: "sell", value: "1" }, policy: { kind: "market", slippageBps: "50", timeInForce: "ioc" },
    });
    const reviewed = { previewId: z.uuid().parse(preview["previewId"]), previewHash: hashSchema.parse(preview["previewHash"]) };
    previews.push(reviewed);
    await call("post_trade", reviewed);
  }
  await call("subscribe_to_user", { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
  await call("get_trades", { source: "all", sort: "occurredAt", direction: "desc", limit: "50" });
  await call("wipe_subscribed_trades", { scope: "address", address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
  await call("unsubscribe_from_user", { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify({
    client: "@modelcontextprotocol/sdk", initialized: true, gracefulShutdown: true,
    negotiatedTools: names, previews, transcript,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
