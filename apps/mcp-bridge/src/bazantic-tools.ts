import { createHash } from "node:crypto";
import { BazanticCatalogClient, discoverGatewayTools } from "@aqua/bazantic";
import { z } from "zod";

const requiredTools = {
  request_trade: ["request_trade", "requestTrade"],
  post_trade: ["post_trade", "postTrade"],
  get_trades: ["get_trades", "getTrades"],
  subscribe_to_user: ["subscribe_to_user", "subscribeToUser"],
  unsubscribe_from_user: ["unsubscribe_from_user", "unsubscribeFromUser"],
  wipe_subscribed_trades: ["wipe_subscribed_trades", "wipeSubscribedTrades"],
} as const;

export type AquaMcpToolName = keyof typeof requiredTools;
export interface BazanticToolEvidence {
  readonly gatewaySlug: string;
  readonly gatewayName: string;
  readonly catalogUrl: string;
  readonly mcpUrl: string;
  readonly fingerprints: Readonly<Record<AquaMcpToolName, string>>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BazanticToolDiscoveryOptions {
  readonly gatewaySlug: string;
  readonly catalogUrl?: string;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${z.array(z.unknown()).parse(value).map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = z.record(z.string(), z.unknown()).parse(value);
    return `{${Object.entries(object).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const schemaFingerprint = (schema: Readonly<Record<string, unknown>>): string =>
  createHash("sha256").update(canonical(schema)).digest("hex");

export const discoverAquaTools = async (options: BazanticToolDiscoveryOptions): Promise<BazanticToolEvidence> => {
  const gatewaySlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u).parse(options.gatewaySlug);
  const catalog = new BazanticCatalogClient({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.catalogUrl === undefined ? {} : { url: options.catalogUrl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
  });
  const gateway = await catalog.getGateway(gatewaySlug);
  if (gateway === null) throw new Error(`Bazantic gateway ${gatewaySlug} was not found`);
  if (gateway.mcpUrl === null) throw new Error(`Bazantic gateway ${gatewaySlug} does not advertise an MCP endpoint`);
  const discovered = await discoverGatewayTools(gateway, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
  });
  if (discovered === null) throw new Error(`Bazantic gateway ${gatewaySlug} MCP endpoint returned 404`);
  const fingerprint = (localName:AquaMcpToolName,aliases:readonly string[]):string => {
    const tool = discovered.find((candidate) => aliases.includes(candidate.name));
    if (tool === undefined) throw new Error(`Bazantic gateway ${gatewaySlug} is missing required operation ${localName}`);
    return schemaFingerprint(tool.inputSchema);
  };
  const fingerprints:Record<AquaMcpToolName,string> = {
    request_trade:fingerprint("request_trade",requiredTools.request_trade),
    post_trade:fingerprint("post_trade",requiredTools.post_trade),
    get_trades:fingerprint("get_trades",requiredTools.get_trades),
    subscribe_to_user:fingerprint("subscribe_to_user",requiredTools.subscribe_to_user),
    unsubscribe_from_user:fingerprint("unsubscribe_from_user",requiredTools.unsubscribe_from_user),
    wipe_subscribed_trades:fingerprint("wipe_subscribed_trades",requiredTools.wipe_subscribed_trades),
  };
  return {
    gatewaySlug,
    gatewayName: gateway.name,
    catalogUrl: options.catalogUrl ?? "https://bazgateway.com/mcp/",
    mcpUrl: gateway.mcpUrl,
    fingerprints: Object.freeze(fingerprints),
  };
};

export const discoverConfiguredAquaTools = async (): Promise<BazanticToolEvidence | null> => {
  const gatewaySlug = Bun.env["AQUA_BAZANTIC_GATEWAY_SLUG"];
  if (gatewaySlug === undefined || gatewaySlug.length === 0) return null;
  return discoverAquaTools({
    gatewaySlug,
    ...(Bun.env["AQUA_BAZANTIC_CATALOG_URL"] === undefined ? {} : { catalogUrl: Bun.env["AQUA_BAZANTIC_CATALOG_URL"] }),
  });
};
