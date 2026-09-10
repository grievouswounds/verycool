#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { BazanticCatalogClient } from "@aqua/bazantic";
import { requiredAquaTools, type AquaMcpToolName } from "../apps/mcp-bridge/src/bazantic-tools.ts";
import { z } from "zod";

export const MCP_CHECK_MODES = ["gateway", "bridge", "all"] as const;
export type McpCheckMode = (typeof MCP_CHECK_MODES)[number];

const doctorSchema = z.object({
  status: z.enum(["ready", "oauth_required", "error"]),
  error: z.object({ message: z.string().min(1) }).loose().optional(),
  probe: z.object({
    oauth: z.object({ required: z.boolean() }).loose().optional(),
  }).loose().optional(),
}).loose();
const toolsListSchema = z.object({
  tools: z.array(z.object({ name: z.string().min(1) }).loose()),
}).loose();
const oauthCacheSchema = z.object({
  resource: z.url(),
  accessToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
}).loose();
const gatewayRecordSchema = z.object({ slug: z.string().min(1) }).loose();

const fail = (message: string): never => {
  console.error(message);
  throw new Error(message);
};

const envOr = (name: string, fallback: string): string => {
  const value = Bun.env[name]?.trim();
  if (value === undefined || value.length === 0) return fallback;
  return value;
};

const requireCommand = (name: string, hint: string): string => {
  const resolved = Bun.which(name);
  if (resolved === null) return fail(`${name} is not on PATH. ${hint}`);
  return resolved;
};

export const parseMcpCheckMode = (value: string): McpCheckMode => {
  if (value === "gateway" || value === "bridge" || value === "all") return value;
  return fail(`mode must be ${MCP_CHECK_MODES.join(", ")}, not ${value}`);
};

export const missingRequiredAquaTools = (names: readonly string[]): readonly AquaMcpToolName[] =>
  (Object.keys(requiredAquaTools) as AquaMcpToolName[]).filter(
    (local) => !requiredAquaTools[local].some((alias) => names.includes(alias)),
  );

export const oauthCacheIsFresh = async (path: string, now = Date.now()): Promise<boolean> => {
  try {
    const cached = oauthCacheSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return cached.expiresAt > now + 30_000;
  } catch {
    return false;
  }
};

export const assertHardwareAmrPath = (env: NodeJS.ProcessEnv): void => {
  const override = env["AQUA_ACCESS_TOKEN"]?.trim();
  if (override !== undefined && override.length > 0) {
    fail("AQUA_ACCESS_TOKEN is set; unset it so the check uses the Ledger FIDO2 OAuth cache instead of a SIWE override.");
  }
};

const runJson = async (command: string, args: readonly string[]): Promise<unknown> => {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", env: Bun.env });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${String(code)}):\n${stderr}\n${stdout}`);
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return {};
  return z.unknown().parse(JSON.parse(trimmed));
};

const resolveSlug = async (root: string): Promise<string> => {
  const fromEnv = Bun.env["AQUA_BAZANTIC_GATEWAY_SLUG"]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const recordPath = `${root}/.data/bazantic-gateway.json`;
  if (!existsSync(recordPath)) {
    return fail("AQUA_BAZANTIC_GATEWAY_SLUG is unset and .data/bazantic-gateway.json is missing. Activate the listing, then set the slug.");
  }
  return gatewayRecordSchema.parse(JSON.parse(await readFile(recordPath, "utf8"))).slug;
};

const assertDoctorReady = (body: unknown, label: string): void => {
  const doctor = doctorSchema.parse(body);
  if (doctor.status === "oauth_required" || doctor.probe?.oauth?.required === true) {
    fail(`${label} reported oauth_required. A draft Bazantic listing 404s every path, including OAuth discovery.`);
  }
  if (doctor.status !== "ready") {
    const detail = doctor.error?.message;
    fail(`${label} doctor status is ${doctor.status}${detail === undefined ? "" : `: ${detail}`}`);
  }
};

const assertToolCatalog = (body: unknown, label: string): void => {
  const listed = toolsListSchema.parse(body);
  const missing = missingRequiredAquaTools(listed.tools.map((tool) => tool.name));
  if (missing.length > 0) fail(`${label} is missing required tools: ${missing.join(", ")}`);
};

const checkGateway = async (mcpjam: string, root: string): Promise<void> => {
  const slug = await resolveSlug(root);
  const gateway = await new BazanticCatalogClient({}).getGateway(slug);
  if (gateway === null) fail(`Bazantic gateway ${slug} was not found in catalog. Activate the listing, then retry.`);
  if (gateway.mcpUrl === null) fail(`Bazantic gateway ${slug} does not advertise an MCP endpoint`);
  const mcpUrl = gateway.mcpUrl;
  assertDoctorReady(await runJson(mcpjam, ["server", "doctor", "--url", mcpUrl, "--quiet", "--format", "json"]), "gateway");
  assertToolCatalog(await runJson(mcpjam, ["tools", "list", "--url", mcpUrl, "--quiet", "--format", "json"]), "gateway");
  await runJson(mcpjam, ["protocol", "conformance", "--url", mcpUrl, "--reporter", "json-summary"]);
  console.log(JSON.stringify({ ok: true, mode: "gateway", slug, mcpUrl }));
};

const checkBridge = async (mcpjam: string, bun: string, root: string): Promise<void> => {
  assertHardwareAmrPath(Bun.env);
  const stateHome = envOr("XDG_STATE_HOME", `${root}/.data/aqua-mcp-state`);
  const oauthPath = envOr("AQUA_OAUTH_CACHE", `${stateHome}/oauth.json`);
  if (!await oauthCacheIsFresh(oauthPath)) {
    fail(`OAuth cache at ${oauthPath} is missing or expired. Warm it once with bun ${root}/apps/mcp-bridge/src/main.ts (AQUA_API_URL=http://localhost:8787, XDG_STATE_HOME=${stateHome}), then retry.`);
  }
  const apiUrl = envOr("AQUA_API_URL", "http://localhost:8787");
  const rpcUrl = envOr("AQUA_RPC_URL", "http://127.0.0.1:8545");
  const envFlags = ["-e", `AQUA_API_URL=${apiUrl}`, "-e", `AQUA_RPC_URL=${rpcUrl}`, "-e", `XDG_STATE_HOME=${stateHome}`];
  const gatewaySlug = Bun.env["AQUA_BAZANTIC_GATEWAY_SLUG"]?.trim();
  if (gatewaySlug !== undefined && gatewaySlug.length > 0) envFlags.push("-e", `AQUA_BAZANTIC_GATEWAY_SLUG=${gatewaySlug}`);
  const stdio = ["--command", bun, "--args", "apps/mcp-bridge/src/main.ts", "--cwd", root, ...envFlags, "--quiet", "--format", "json"] as const;
  assertDoctorReady(await runJson(mcpjam, ["server", "doctor", ...stdio]), "bridge");
  assertToolCatalog(await runJson(mcpjam, ["tools", "list", ...stdio]), "bridge");
  console.log(JSON.stringify({ ok: true, mode: "bridge", apiUrl, stateHome }));
};

const main = async (): Promise<void> => {
  const mode = parseMcpCheckMode(Bun.argv[2] ?? "all");
  const root = envOr("AQUA_ROOT", process.cwd());
  const mcpjam = requireCommand("mcpjam", "Add @mcpjam/cli as a development dependency with aube so the binary is on PATH.");
  const bun = requireCommand("bun", "Enter the Nix shell so bun is on PATH.");
  if (mode === "gateway" || mode === "all") await checkGateway(mcpjam, root);
  if (mode === "bridge" || mode === "all") await checkBridge(mcpjam, bun, root);
};

if (import.meta.main) {
  try {
    await main();
  } catch {
    process.exit(1);
  }
}
