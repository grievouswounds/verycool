import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { discoverAquaTools } from "../../apps/mcp-bridge/src/mcp-tools.ts";

const origin = Bun.env["AQUA_PUBLIC_ORIGIN"]?.replace(/\/$/u, "");
if (origin === undefined || origin.length === 0) throw new Error("AQUA_PUBLIC_ORIGIN is required for the hosted MCP canary");
const evidence = await discoverAquaTools({ mcpUrl: `${origin}/mcp` });
const output = Bun.env["AQUA_E2E_REPORT"] ?? "reports/e2e/hosted-mcp-canary.json";
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, `${JSON.stringify({ createdAt: new Date().toISOString(), ...evidence }, null, 2)}\n`);
console.log(`Hosted MCP canary passed for ${evidence.mcpUrl}`);
