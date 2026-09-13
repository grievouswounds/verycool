import { createHash } from "node:crypto";
import { parseStrictJson, readBoundedText } from "@aqua/core";
import { z } from "zod";

export const requiredAquaTools = {
  request_trade: "request_trade",
  post_trade: "post_trade",
  get_trades: "get_trades",
  cancel_trade: "cancel_trade",
  subscribe_to_user: "subscribe_to_user",
  unsubscribe_from_user: "unsubscribe_from_user",
  wipe_subscribed_trades: "wipe_subscribed_trades",
  get_balances: "get_balances",
} as const;

export type AquaMcpToolName = keyof typeof requiredAquaTools;
export interface AquaToolEvidence {
  readonly mcpUrl: string;
  readonly fingerprints: Readonly<Record<AquaMcpToolName, string>>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${z.array(z.unknown()).parse(value).map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = z.record(z.string(), z.unknown()).parse(value);
    return `{${Object.entries(object).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const schemaFingerprint = (schema: Readonly<Record<string, unknown>>): string =>
  createHash("sha256").update(canonical(schema)).digest("hex");

const toolsEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  result: z.object({
    tools: z.array(z.object({
      name: z.string().min(1),
      inputSchema: z.record(z.string(), z.unknown()),
    }).loose()),
  }).loose(),
}).loose();

export const discoverAquaTools = async (options: {
  readonly mcpUrl: string;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}): Promise<AquaToolEvidence> => {
  const mcpUrl = z.url().parse(options.mcpUrl);
  const fetch_ = options.fetch ?? globalThis.fetch;
  const timeoutMs = z.number().int().positive().parse(options.timeoutMs ?? 30_000);
  const response = await fetch_(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Hosted MCP tools/list failed with HTTP ${String(response.status)}`);
  const text = await readBoundedText(response, options.maxResponseBytes);
  const parsed = text.startsWith("event:")
    ? parseStrictJson(text.replaceAll("\r\n", "\n").split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"))
    : parseStrictJson(text);
  const tools = toolsEnvelopeSchema.parse(parsed).result.tools;
  const fingerprint = (name: AquaMcpToolName): string => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`Hosted MCP is missing required operation ${name}`);
    return schemaFingerprint(tool.inputSchema);
  };
  const names = Object.keys(requiredAquaTools) as AquaMcpToolName[];
  return {
    mcpUrl,
    fingerprints: Object.freeze(Object.fromEntries(names.map((name) => [name, fingerprint(name)])) as Record<AquaMcpToolName, string>),
  };
};
