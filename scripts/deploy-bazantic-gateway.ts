#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { hexSchema, parseRuntimeManifest, runtimeManifestHash, type Hex, type RuntimeManifest } from "@aqua/core";
import { signPersonalMessage, signingKeyAddress } from "@aqua/evm";
import { z } from "zod";
import { applyLedgerMode, parseLedgerArgv } from "./ledger-mode.ts";

export const GATEWAY_NAME = "Aqua transaction preparation API";
/** Foundry Anvil account 0; used only against the local SIWE issuer. */
export const ANVIL_ACCOUNT_ZERO_KEY = hexSchema.parse("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const VERCEL_STAGING_DIR = "out/vercel";

const challengeResponseSchema = z.object({ challengeId: z.uuid(), message: z.string().min(1) }).loose();
const sessionResponseSchema = z.object({ accessToken: z.string().min(1), expiresIn: z.number().int().positive() }).loose();
const whoamiSchema = z.object({
  ok: z.boolean(),
  signedIn: z.boolean(),
  scopes: z.array(z.string()),
}).loose();
const gatewayAddSchema = z.object({
  ok: z.literal(true),
  id: z.string().min(1),
  slug: z.string().min(1),
  mcpUrl: z.url(),
}).loose();
const openApiSchema = z.object({
  openapi: z.string().min(1),
  paths: z.record(z.string(), z.unknown()),
}).loose();

export const parseVercelDeploymentUrl = (text: string): string | undefined => {
  const match = /https:\/\/[a-z0-9.-]+\.vercel\.app/u.exec(text);
  return match?.[0];
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

const mintSiweAccessToken = async (origin: string, signingKey: Hex): Promise<string> => {
  const address = signingKeyAddress(signingKey);
  const challenge = challengeResponseSchema.parse(await jsonBody(await fetch(new URL("/v1/auth/challenges", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  }), "auth challenge"));
  const signature = signPersonalMessage(signingKey, challenge.message);
  const session = sessionResponseSchema.parse(await jsonBody(await fetch(new URL("/v1/auth/sessions", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, message: challenge.message, signature }),
  }), "auth session"));
  return session.accessToken;
};

const runCaptured = async (command: string, args: readonly string[], options: { stdin?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const child = Bun.spawn([command, ...args], {
    stdout: "pipe", stderr: "pipe", env: Bun.env,
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  return { stdout, stderr, exitCode: await child.exited };
};

const runJson = async (command: string, args: readonly string[]): Promise<unknown> => {
  const result = await runCaptured(command, args);
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  return z.unknown().parse(JSON.parse(result.stdout));
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
  await Bun.write(`${staging}/vercel.json`, `${JSON.stringify({ bunVersion: "1.x", installCommand: "echo skip", buildCommand: "echo skip" }, null, 2)}\n`);
  const install = Bun.spawn([bun, "install"], { cwd: staging, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: Bun.env });
  const stderr = await new Response(install.stderr).text();
  if (await install.exited !== 0) fail(`staging bun install failed:\n${stderr}`);
  return staging;
};

const upsertVercelEnv = async (name: string, value: string, environment: "production" | "preview" = "production"): Promise<void> => {
  const [cli, ...prefix] = vercelCli();
  await runCaptured(cli, [...prefix, "env", "rm", name, environment, "--yes"]);
  const added = await runCaptured(cli, [...prefix, "env", "add", name, environment], { stdin: `${value}\n` });
  if (added.exitCode !== 0) fail(`vercel env add ${name} failed:\n${added.stderr}\n${added.stdout}`);
};

export const deployToVercel = async (staging: string): Promise<string> => {
  const [cli, ...prefix] = vercelCli();
  const deployed = await runCaptured(cli, [...prefix, "deploy", "--prod", "--yes", "--cwd", staging]);
  if (deployed.exitCode !== 0) fail(`vercel deploy failed:\n${deployed.stderr}\n${deployed.stdout}`);
  const url = parseVercelDeploymentUrl(`${deployed.stdout}\n${deployed.stderr}`);
  if (url === undefined) return fail(`vercel deploy did not print a *.vercel.app URL\n${deployed.stdout}\n${deployed.stderr}`);
  return url;
};

const loadProductionManifest = async (stateDir: string): Promise<RuntimeManifest> => {
  const fromEnv = Bun.env["AQUA_RUNTIME_MANIFEST"]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return parseRuntimeManifest(fromEnv);
  const path = `${stateDir}/runtime-manifest.production.json`;
  return parseRuntimeManifest(await Bun.file(path).text());
};

const writeSecretFile = async (path: string, contents: string): Promise<void> => {
  await Bun.write(path, contents);
  const { chmod } = await import("node:fs/promises");
  await chmod(path, 0o600);
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
  const signingKey = hexSchema.parse(envOr("AQUA_DEPLOY_SIGNING_KEY", ANVIL_ACCOUNT_ZERO_KEY));
  await mkdir(stateDir, { recursive: true });
  const databaseUrl = pooledDatabaseUrl();
  Bun.env["DATABASE_URL"] = databaseUrl;

  requireCommand("baz", "Install @bazantic/cli and run `baz login` with gateway:read and gateway:write.");
  const whoami = whoamiSchema.parse(await runJson("baz", ["whoami", "--json"]));
  if (!whoami.ok || !whoami.signedIn) fail("baz is not signed in. Run `baz login`.");
  if (!whoami.scopes.includes("gateway:write")) fail("this baz session lacks gateway:write; run `baz login` again.");

  const migrate = await runCaptured(requireCommand("bun", "Install Bun to run migrations."), ["scripts/migrate.ts"]);
  if (migrate.exitCode !== 0) fail(`database migration failed:\n${migrate.stderr}\n${migrate.stdout}`);

  let manifest = await loadProductionManifest(stateDir);
  const existingOrigin = Bun.env["AQUA_VERCEL_URL"]?.trim();
  const staging = await buildVercelBundle(process.cwd());
  const pushRuntimeEnv = async (current: RuntimeManifest): Promise<void> => {
    const agent = envOr("AQUA_AGENT_KEY", "");
    const facilitator = envOr("AQUA_FACILITATOR_KEY", "");
    const keeper = envOr("AQUA_KEEPER_KEY", "");
    const paseto = envOr("PASETO_V4_SECRET_KEY", "");
    if (agent.length === 0 || facilitator.length === 0 || keeper.length === 0 || paseto.length === 0) {
      fail("AQUA_AGENT_KEY, AQUA_FACILITATOR_KEY, AQUA_KEEPER_KEY, and PASETO_V4_SECRET_KEY are required for AQUA_SIGNER=env");
    }
    await upsertVercelEnv("AQUA_RUNTIME_MANIFEST", JSON.stringify(current));
    await upsertVercelEnv("AQUA_SIGNER", "env");
    await upsertVercelEnv("AQUA_AGENT_KEY", agent);
    await upsertVercelEnv("AQUA_FACILITATOR_KEY", facilitator);
    await upsertVercelEnv("AQUA_KEEPER_KEY", keeper);
    await upsertVercelEnv("PASETO_V4_SECRET_KEY", paseto);
  };
  let origin: string;
  if (existingOrigin !== undefined && existingOrigin.length > 0) {
    origin = existingOrigin.replace(/\/$/u, "");
    manifest = rewriteManifestPublicOrigin(manifest, origin);
    await pushRuntimeEnv(manifest);
    origin = await deployToVercel(staging);
  } else {
    await pushRuntimeEnv(manifest);
    origin = await deployToVercel(staging);
    const rewritten = rewriteManifestPublicOrigin(manifest, origin);
    if (rewritten.services.apiUrl !== manifest.services.apiUrl) {
      manifest = rewritten;
      await pushRuntimeEnv(manifest);
      origin = await deployToVercel(staging);
    } else {
      manifest = rewritten;
    }
  }

  await waitForPublicOrigin(origin);
  const token = await mintSiweAccessToken(origin, signingKey);
  const tokenPath = `${stateDir}/bazantic-access.token`;
  await writeSecretFile(tokenPath, token);
  const created = gatewayAddSchema.parse(await runJson("baz", [
    "gateway", "add",
    "--spec-url", `${origin}/openapi.json`,
    "--endpoint", origin,
    "--name", GATEWAY_NAME,
    "--auth-type", "api-key",
    "--status", "draft",
    "--json",
  ]));
  const record = {
    id: created.id,
    slug: created.slug,
    mcpUrl: created.mcpUrl,
    origin,
    name: GATEWAY_NAME,
    tokenPath,
    dashboard: "https://bazantic.com",
    mcpJam: {
      http: { transport: "streamable-http", url: created.mcpUrl },
      stdio: {
        command: "bun",
        args: ["apps/mcp-bridge/src/main.ts"],
        env: {
          AQUA_API_URL: origin,
          AQUA_RPC_URL: envOr("AQUA_RPC_URL", manifest.chain.rpcUrl),
          XDG_STATE_HOME: `${stateDir}/aqua-mcp-state`,
        },
      },
    },
    createdAt: new Date().toISOString(),
  };
  await Bun.write(`${stateDir}/bazantic-gateway.json`, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    id: created.id,
    slug: created.slug,
    mcpUrl: created.mcpUrl,
    origin,
    tokenPath,
    next: [
      "Open the Bazantic dashboard, set API key delivery to bearer, paste the token file, set prices, and activate.",
      "MCP Jam HTTP: add mcpUrl as Streamable HTTP after activation; tools/call returns 402.",
      "MCP Jam STDIO: bun apps/mcp-bridge/src/main.ts with AQUA_API_URL pointing at the Vercel origin and a hardware-AMR token.",
    ],
  }, null, 2));
};

if (import.meta.main) {
  try {
    await deploy();
  } catch {
    process.exit(1);
  }
}
