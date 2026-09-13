#!/usr/bin/env bun
import { requiredAquaTools, type AquaMcpToolName } from "../apps/mcp-bridge/src/mcp-tools.ts";
import { applyLedgerArgv, type LedgerMode } from "./ledger-mode.ts";
import { parseStrictJson } from "@aqua/core";
import { z } from "zod";

export const MCP_CHECK_MODES = ["bridge", "hosted", "all"] as const;
export const MCP_CHECK_OAUTH_REUSE_ENV = ["-e", "AQUA_OAUTH_REUSE_CACHE=1"] as const;
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
  if (value === "bridge" || value === "hosted" || value === "all") return value;
  return fail(`mode must be ${MCP_CHECK_MODES.join(", ")}, not ${value}`);
};

export const missingRequiredAquaTools = (names: readonly string[]): readonly AquaMcpToolName[] => {
  const locals = Object.keys(requiredAquaTools) as AquaMcpToolName[];
  return locals.filter((local) => !names.includes(requiredAquaTools[local]));
};

export const oauthCacheIsFresh = async (path: string, now = Date.now()): Promise<boolean> => {
  try {
    const cached = oauthCacheSchema.parse(parseStrictJson(await Bun.file(path).text()));
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
  return z.unknown().parse(parseStrictJson(trimmed));
};

const assertDoctorReady = (body: unknown, label: string): void => {
  const doctor = doctorSchema.parse(body);
  if (doctor.status === "oauth_required" || doctor.probe?.oauth?.required === true) {
    fail(`${label} reported oauth_required. Complete Ledger FIDO2 OAuth, then retry.`);
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

const checkHosted = async (mcpjam: string): Promise<void> => {
  const origin = envOr("AQUA_PUBLIC_ORIGIN", "").replace(/\/$/u, "");
  if (origin.length === 0) return fail("AQUA_PUBLIC_ORIGIN is required for hosted MCP checks");
  const mcpUrl = `${origin}/mcp`;
  assertDoctorReady(await runJson(mcpjam, ["server", "doctor", "--url", mcpUrl, "--quiet", "--format", "json"]), "hosted");
  assertToolCatalog(await runJson(mcpjam, ["tools", "list", "--url", mcpUrl, "--quiet", "--format", "json"]), "hosted");
  await runJson(mcpjam, ["protocol", "conformance", "--url", mcpUrl, "--reporter", "json-summary"]);
  await runJson(mcpjam, ["oauth", "conformance", "--url", mcpUrl, "--reporter", "json-summary"]);
  console.log(JSON.stringify({ ok: true, mode: "hosted", mcpUrl }));
};

const checkBridge = async (mcpjam: string, bun: string, root: string, ledger: LedgerMode): Promise<void> => {
  assertHardwareAmrPath(Bun.env);
  const stateHome = envOr("XDG_STATE_HOME", `${root}/.data/aqua-mcp-state`);
  const oauthPath = envOr("AQUA_OAUTH_CACHE", `${stateHome}/oauth.json`);
  if (!await oauthCacheIsFresh(oauthPath)) {
    fail(`OAuth cache at ${oauthPath} is missing or expired. Warm it once with bun ${root}/apps/mcp-bridge/src/main.ts --${ledger === "emulator" ? "dev" : "prod"} (AQUA_API_URL=http://localhost:8787, XDG_STATE_HOME=${stateHome}), then retry.`);
  }
  const apiUrl = envOr("AQUA_API_URL", "http://localhost:8787");
  const rpcUrl = envOr("AQUA_RPC_URL", "http://127.0.0.1:8545");
  const envFlags = [
    "-e", `AQUA_API_URL=${apiUrl}`,
    "-e", `AQUA_RPC_URL=${rpcUrl}`,
    "-e", `XDG_STATE_HOME=${stateHome}`,
    "-e", `AQUA_LEDGER=${ledger}`,
    "-e", `AQUA_LEDGER_TRANSPORT=${Bun.env["AQUA_LEDGER_TRANSPORT"] ?? (ledger === "emulator" ? "speculos" : "node-hid")}`,
    ...MCP_CHECK_OAUTH_REUSE_ENV,
  ];
  if (ledger === "emulator") {
    envFlags.push("-e", "AQUA_E2E=1");
    if (Bun.env["AQUA_WALLET_CLI"] !== undefined) envFlags.push("-e", `AQUA_WALLET_CLI=${Bun.env["AQUA_WALLET_CLI"]}`);
    if (Bun.env["AQUA_SPECULOS_URL"] !== undefined) envFlags.push("-e", `AQUA_SPECULOS_URL=${Bun.env["AQUA_SPECULOS_URL"]}`);
  }
  const stdio = ["--command", bun, "--args", "apps/mcp-bridge/src/main.ts", "--cwd", root, ...envFlags, "--quiet", "--format", "json"] as const;
  assertDoctorReady(await runJson(mcpjam, ["server", "doctor", ...stdio]), "bridge");
  assertToolCatalog(await runJson(mcpjam, ["tools", "list", ...stdio]), "bridge");
  console.log(JSON.stringify({ ok: true, mode: "bridge", ledger, apiUrl, stateHome }));
};

const main = async (): Promise<void> => {
  const parsed = applyLedgerArgv(Bun.argv.slice(2));
  const mode = parseMcpCheckMode(parsed.rest[0] ?? "all");
  const root = envOr("AQUA_ROOT", process.cwd());
  const mcpjam = requireCommand("mcpjam", "Add @mcpjam/cli as a development dependency with aube so the binary is on PATH.");
  const bun = requireCommand("bun", "Enter the Nix shell so bun is on PATH.");
  if (mode === "hosted") await checkHosted(mcpjam);
  if (mode === "all" && (Bun.env["AQUA_PUBLIC_ORIGIN"]?.trim() ?? "").length > 0) await checkHosted(mcpjam);
  if (mode === "bridge" || mode === "all") await checkBridge(mcpjam, bun, root, parsed.mode);
};

if (import.meta.main) {
  try {
    await main();
  } catch {
    process.exit(1);
  }
}
