#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { parseRuntimeManifest, runtimeManifestHash, type RuntimeManifest } from "@aqua/core";
import { parseAgentKek } from "@aqua/adapters";
import { z } from "zod";
import { applyLedgerMode, parseLedgerArgv } from "./ledger-mode.ts";

export const PINNED_PUBLIC_ORIGIN = "https://vercel-henna-gamma-46.vercel.app";
export const VERCEL_STAGING_DIR = "out/vercel";
export const HOSTED_VERCEL_CONFIG = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  bunVersion: "1.x",
  framework: "bun",
  functions: { "src/server.js": { maxDuration: 300 } },
} as const;

const openApiSchema = z.object({
  openapi: z.string().min(1),
  paths: z.record(z.string(), z.unknown()),
}).loose();

const fail = (message: string): never => {
  throw new Error(message);
};

export const parseAliasedVercelUrl = (text: string): string | undefined => {
  const aliased = /Aliased\s+(https:\/\/[a-z0-9.-]+\.vercel\.app)/u.exec(text);
  return aliased?.[1];
};

export const parseVercelDeploymentUrl = (text: string): string | undefined => {
  return parseAliasedVercelUrl(text);
};

export const requirePublicOrigin = (env: NodeJS.ProcessEnv): string => {
  const publicOrigin = (env["AQUA_PUBLIC_ORIGIN"] ?? "").trim().replace(/\/$/u, "");
  if (publicOrigin.length === 0) return fail("AQUA_PUBLIC_ORIGIN is required and is the sole public host");
  const vercelUrl = (env["AQUA_VERCEL_URL"] ?? "").trim().replace(/\/$/u, "");
  if (vercelUrl.length > 0 && vercelUrl !== publicOrigin) {
    return fail(`AQUA_VERCEL_URL ${vercelUrl} disagrees with AQUA_PUBLIC_ORIGIN ${publicOrigin}`);
  }
  return publicOrigin;
};

export const assertAliasedOrigin = (log: string, expected: string): string => {
  const aliased = parseAliasedVercelUrl(log);
  if (aliased === undefined) return fail("vercel deploy did not print an Aliased https://*.vercel.app host");
  if (aliased !== expected) return fail(`Aliased host ${aliased} differs from AQUA_PUBLIC_ORIGIN ${expected}. Never enrol against a unique *.vercel.app URL.`);
  return aliased;
};

export const rewriteManifestPublicOrigin = (manifest: RuntimeManifest, origin: string): RuntimeManifest => {
  const apiUrl = origin.replace(/\/$/u, "");
  const hostname = new URL(apiUrl).hostname;
  const next = {
    ...manifest,
    services: { ...manifest.services, apiUrl, facilitatorUrl: `${apiUrl}/facilitator` },
    auth: { ...manifest.auth, issuer: apiUrl, resource: apiUrl, origin: apiUrl, rpId: hostname },
  };
  const unsigned = { ...next };
  delete unsigned.manifestHash;
  const parsed = parseRuntimeManifest(JSON.stringify(unsigned));
  return parseRuntimeManifest(JSON.stringify({ ...parsed, manifestHash: runtimeManifestHash(parsed) }));
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

const jsonBody = async (response: Response, label: string): Promise<unknown> => {
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`${label} ${String(response.status)} ${response.url}: ${JSON.stringify(body)}`);
  return body;
};

const waitForPublicOrigin = async (origin: string): Promise<void> => {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      const live = await fetch(new URL("/health/live", origin));
      if (!live.ok) {
        await Bun.sleep(2_000);
        continue;
      }
      const document = openApiSchema.parse(await jsonBody(await fetch(new URL("/openapi.json", origin)), "openapi"));
      if (Object.keys(document.paths).length === 0) throw new Error("OpenAPI document declares no operations");
      return;
    } catch {
      await Bun.sleep(2_000);
    }
  }
  fail(`Public origin ${origin} did not serve /health/live and /openapi.json`);
};

const teeText = async (stream: ReadableStream<Uint8Array>, dest: NodeJS.WriteStream): Promise<string> => {
  const buffer = Buffer.from(await new Response(stream).arrayBuffer());
  dest.write(buffer);
  return buffer.toString("utf8");
};

const runCaptured = async (command: string, args: readonly string[], options: { stdin?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const child = Bun.spawn([command, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...Bun.env, CI: "1" },
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
  });
  const [stdout, stderr] = await Promise.all([teeText(child.stdout, process.stdout), teeText(child.stderr, process.stderr)]);
  return { stdout, stderr, exitCode: await child.exited };
};

const vercelCli = (): readonly [string, ...string[]] => {
  const resolved = Bun.which("vercel");
  if (resolved !== null) return [resolved];
  const bun = requireCommand("bun", "Install Bun so `bunx vercel` can deploy.");
  return [bun, "x", "--bun", "vercel@latest"];
};

export const buildVercelBundle = async (root: string): Promise<string> => {
  const staging = `${root}/${VERCEL_STAGING_DIR}`;
  await mkdir(`${staging}/src`, { recursive: true });
  const bun = requireCommand("bun", "Install Bun to bundle the hosted API.");
  const build = await runCaptured(bun, ["build", `${root}/apps/api/src/hosted.ts`, "--target=bun", "--outfile", `${staging}/src/server.js`]);
  if (build.exitCode !== 0) fail(`bun build failed:\n${build.stderr}\n${build.stdout}`);
  await Bun.write(`${staging}/package.json`, `${JSON.stringify({
    name: "aqua-hosted",
    private: true,
    type: "module",
    scripts: { build: "echo skip" },
  }, null, 2)}\n`);
  await Bun.write(`${staging}/vercel.json`, `${JSON.stringify(HOSTED_VERCEL_CONFIG, null, 2)}\n`);
  const stagingLink = `${staging}/.vercel/project.json`;
  const rootLink = `${root}/.vercel/project.json`;
  if (existsSync(stagingLink) && existsSync(rootLink)) {
    const stagingProject = z.object({ projectId: z.string() }).loose().parse(JSON.parse(await Bun.file(stagingLink).text()));
    const rootProject = z.object({ projectId: z.string() }).loose().parse(JSON.parse(await Bun.file(rootLink).text()));
    if (stagingProject.projectId === rootProject.projectId) await unlink(stagingLink);
  }
  const install = Bun.spawn([bun, "install"], { cwd: staging, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...Bun.env, CI: "1" } });
  const stderr = await new Response(install.stderr).text();
  if (await install.exited !== 0) fail(`staging bun install failed:\n${stderr}`);
  return staging;
};

const upsertVercelEnv = async (cwd: string, name: string, value: string, environment: "production" | "preview" = "production"): Promise<void> => {
  const [cli, ...prefix] = vercelCli();
  console.error(`upserting ${name} (${environment})`);
  await runCaptured(cli, [...prefix, "env", "rm", name, environment, "--yes", "--cwd", cwd]);
  const added = await runCaptured(cli, [...prefix, "env", "add", name, environment, "--yes", "--cwd", cwd], { stdin: `${value}\n` });
  if (added.exitCode !== 0) fail(`vercel env add ${name} failed:\n${added.stderr}\n${added.stdout}`);
};

export const deployToVercel = async (staging: string, expectedOrigin: string): Promise<string> => {
  const [cli, ...prefix] = vercelCli();
  console.error(`deploying ${staging} to Vercel production`);
  const deployed = await runCaptured(cli, [...prefix, "deploy", "--prod", "--yes", "--cwd", staging]);
  if (deployed.exitCode !== 0) fail(`vercel deploy failed:\n${deployed.stderr}\n${deployed.stdout}`);
  return assertAliasedOrigin(`${deployed.stdout}\n${deployed.stderr}`, expectedOrigin);
};

const loadProductionManifest = async (stateDir: string): Promise<RuntimeManifest> => {
  const fromEnv = Bun.env["AQUA_RUNTIME_MANIFEST"]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return parseRuntimeManifest(fromEnv);
  const path = `${stateDir}/runtime-manifest.production.json`;
  if (!existsSync(path)) {
    return fail(`Missing ${path}. Run bun scripts/deploy-public-chain.ts first so it can reuse the pinned Sepolia contracts and write that file.`);
  }
  return parseRuntimeManifest(await Bun.file(path).text());
};

const pooledDatabaseUrl = (): string => {
  const url = Bun.env["DATABASE_URL"]?.trim() ?? Bun.env["POSTGRES_URL"]?.trim();
  if (url === undefined || url.length === 0) {
    return fail("DATABASE_URL is required. Provision Neon Postgres from the Vercel Marketplace and use the pooled (-pooler) connection string.");
  }
  if (!url.includes("-pooler") && !url.includes("localhost") && !url.includes("127.0.0.1")) {
    console.error("warning: DATABASE_URL does not look like a Neon pooled host; serverless concurrency may exhaust connections");
  }
  return url;
};

const deploy = async (): Promise<void> => {
  const parsed = parseLedgerArgv(Bun.argv.slice(2));
  if (parsed.explicit) applyLedgerMode(parsed.mode, Bun.env);
  const stateDir = envOr("AQUA_STATE_DIR", `${process.cwd()}/.data`);
  const origin = requirePublicOrigin(Bun.env);
  await mkdir(stateDir, { recursive: true });
  const databaseUrl = pooledDatabaseUrl();
  Bun.env["DATABASE_URL"] = databaseUrl;

  if (Bun.which("vercel") === null) {
    console.error("vercel CLI is not on PATH; using bunx vercel@latest. Install it with `npm i -g vercel` to skip the download and interactive prompts.");
  }

  console.error("migrating database");
  const migrate = await runCaptured(requireCommand("bun", "Install Bun to run migrations."), ["scripts/migrate.ts"]);
  if (migrate.exitCode !== 0) fail(`database migration failed:\n${migrate.stderr}\n${migrate.stdout}`);

  const manifest = rewriteManifestPublicOrigin(await loadProductionManifest(stateDir), origin);
  console.error("bundling hosted API");
  const staging = await buildVercelBundle(process.cwd());
  const pushRuntimeEnv = async (current: RuntimeManifest): Promise<void> => {
    const agent = envOr("AQUA_AGENT_KEY", "");
    const facilitator = envOr("AQUA_FACILITATOR_KEY", "");
    const keeper = envOr("AQUA_KEEPER_KEY", "");
    const paseto = envOr("PASETO_V4_SECRET_KEY", "");
    const kek = envOr("AQUA_AGENT_KEK", "");
    if (agent.length === 0 || facilitator.length === 0 || keeper.length === 0 || paseto.length === 0) {
      fail("AQUA_AGENT_KEY, AQUA_FACILITATOR_KEY, AQUA_KEEPER_KEY, and PASETO_V4_SECRET_KEY are required for AQUA_SIGNER=env");
    }
    parseAgentKek(kek);
    await upsertVercelEnv(staging, "DATABASE_URL", databaseUrl);
    await upsertVercelEnv(staging, "AQUA_RUNTIME_MANIFEST", JSON.stringify(current));
    await upsertVercelEnv(staging, "AQUA_SIGNER", "env");
    await upsertVercelEnv(staging, "AQUA_AGENT_KEY", agent);
    await upsertVercelEnv(staging, "AQUA_AGENT_KEK", kek);
    await upsertVercelEnv(staging, "AQUA_FACILITATOR_KEY", facilitator);
    await upsertVercelEnv(staging, "AQUA_KEEPER_KEY", keeper);
    await upsertVercelEnv(staging, "PASETO_V4_SECRET_KEY", paseto);
    await upsertVercelEnv(staging, "AQUA_PUBLIC_ORIGIN", origin);
  };
  if (!existsSync(`${staging}/.vercel/project.json`)) {
    console.error("creating hosted API Vercel project");
  }
  await pushRuntimeEnv(manifest);
  const deployedOrigin = await deployToVercel(staging, origin);
  if (deployedOrigin !== origin) fail(`Deployed alias ${deployedOrigin} is not AQUA_PUBLIC_ORIGIN ${origin}`);

  console.error(`waiting for ${origin} /health/live`);
  await waitForPublicOrigin(origin);
  console.log(JSON.stringify({
    ok: true,
    origin,
    mcpUrl: `${origin}/mcp`,
    mcpJam: "stdio aqua-ledger-key-ring",
    next: [
      "MCP Jam: add one stdio server bun apps/mcp-bridge/src/main.ts --prod with AQUA_API_URL, AQUA_RPC_URL, and XDG_STATE_HOME.",
      "Hosted origin /mcp remains for mcp-check hosted / OAuth conformance, not Jam.",
    ],
  }, null, 2));
};

if (import.meta.main) {
  try {
    await deploy();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
