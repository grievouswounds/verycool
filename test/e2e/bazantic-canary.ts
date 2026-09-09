import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { discoverAquaTools } from "../../apps/mcp-bridge/src/bazantic-tools.ts";

const slug = Bun.env["AQUA_BAZANTIC_GATEWAY_SLUG"];
if (slug === undefined || slug.length === 0) throw new Error("AQUA_BAZANTIC_GATEWAY_SLUG is required for the live canary");
const evidence = await discoverAquaTools({ gatewaySlug: slug });
const output = Bun.env["AQUA_E2E_REPORT"] ?? "reports/e2e/bazantic-canary.json";
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, `${JSON.stringify({ createdAt: new Date().toISOString(), paymentAttempted: false, ...evidence }, null, 2)}\n`);
console.log(`Bazantic discovery canary passed for ${evidence.gatewaySlug}`);
