#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { hexSchema, type Hex } from "@aqua/core";
import { signPersonalMessage, signingKeyAddress } from "@aqua/evm";
import { z } from "zod";

export const DEFAULT_API_ORIGIN = "http://127.0.0.1:8787";
export const GATEWAY_NAME = "Aqua transaction preparation API";
/** Foundry Anvil account 0; used only against the local SIWE issuer. */
export const ANVIL_ACCOUNT_ZERO_KEY = hexSchema.parse("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

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

export const parseTrycloudflareUrl = (text: string): string | undefined => {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u.exec(text);
  return match?.[0];
};

export const DEPLOY_STACKS = ["dev", "dev-emulated"] as const;
export type DeployStack = (typeof DEPLOY_STACKS)[number];

export const parseDeployStack = (value: string): DeployStack => {
  if (value === "dev" || value === "dev-emulated") return value;
  return fail(`AQUA_DEPLOY_STACK must be ${DEPLOY_STACKS.join(" or ")}, not ${value}`);
};

export const keyringIsComplete = (stateDir: string): boolean =>
  ["agent", "facilitator", "keeper", "paseto"].every((name) => existsSync(`${stateDir}/keyring/${name}.enc`));

export const defaultDeployStack = (options: { readonly keyringPresent: boolean }): DeployStack =>
  options.keyringPresent ? "dev" : "dev-emulated";

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

const liveApi = async (origin: string): Promise<boolean> => {
  try {
    return (await fetch(new URL("/health/live", origin))).ok;
  } catch {
    return false;
  }
};

const waitForLocalApi = async (origin: string, attempts: number, hint: string): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await liveApi(origin)) return;
    await Bun.sleep(1_000);
  }
  fail(`API is not serving ${origin}/health/live. ${hint}`);
};

const startNixStack = (stack: DeployStack): ReturnType<typeof Bun.spawn> => {
  const nix = requireCommand("nix", `Install Nix so nix develop -c ${stack} can start the API.`);
  console.error(`starting API with nix develop -c ${stack}`);
  return Bun.spawn([nix, "develop", "-c", stack], { stdout: "inherit", stderr: "inherit", stdin: "ignore", env: Bun.env });
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

const runJson = async (command: string, args: readonly string[]): Promise<unknown> => {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", env: Bun.env });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${stderr}\n${stdout}`);
  return z.unknown().parse(JSON.parse(stdout));
};

const pipedStream = (stream: ReadableStream<Uint8Array> | number | undefined): ReadableStream<Uint8Array> => {
  if (stream instanceof ReadableStream) return stream;
  throw new Error("cloudflared stdio was not piped");
};

const startQuickTunnel = async (localOrigin: string): Promise<{ readonly url: string; readonly child: ReturnType<typeof Bun.spawn> }> => {
  const binary = requireCommand("cloudflared", "Enter `nix develop` so cloudflared is provided, or install cloudflared.");
  const child = Bun.spawn([binary, "tunnel", "--url", localOrigin], { stdout: "pipe", stderr: "pipe", env: Bun.env });
  const decoder = new TextDecoder();
  let combined = "";
  const append = async (stream: ReadableStream<Uint8Array>): Promise<string | undefined> => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return undefined;
      combined += decoder.decode(value);
      const url = parseTrycloudflareUrl(combined);
      if (url !== undefined) return url;
    }
  };
  const found = await Promise.race([
    append(pipedStream(child.stderr)),
    append(pipedStream(child.stdout)),
    Bun.sleep(60_000).then(() => undefined),
  ]);
  if (found === undefined) {
    child.kill();
    return fail(`cloudflared did not print a trycloudflare URL within 60s\n${combined}`);
  }
  return { url: found, child };
};

const writeSecretFile = async (path: string, contents: string): Promise<void> => {
  await Bun.write(path, contents);
  await chmod(path, 0o600);
};

const deploy = async (): Promise<void> => {
  const apiOrigin = envOr("AQUA_API_URL", DEFAULT_API_ORIGIN);
  const stateDir = envOr("AQUA_STATE_DIR", `${process.cwd()}/.data`);
  const signingKey = hexSchema.parse(envOr("AQUA_DEPLOY_SIGNING_KEY", ANVIL_ACCOUNT_ZERO_KEY));
  const holdTunnel = Bun.env["AQUA_DEPLOY_HOLD_TUNNEL"] !== "0";
  const stackOverride = Bun.env["AQUA_DEPLOY_STACK"]?.trim();
  const stack = stackOverride === undefined || stackOverride.length === 0
    ? defaultDeployStack({ keyringPresent: keyringIsComplete(stateDir) })
    : parseDeployStack(stackOverride);
  await mkdir(stateDir, { recursive: true });

  requireCommand("baz", "Install @bazantic/cli and run `baz login` with gateway:read and gateway:write.");
  const whoami = whoamiSchema.parse(await runJson("baz", ["whoami", "--json"]));
  if (!whoami.ok || !whoami.signedIn) fail("baz is not signed in. Run `baz login`.");
  if (!whoami.scopes.includes("gateway:write")) fail("this baz session lacks gateway:write; run `baz login` again.");

  let stackChild: ReturnType<typeof Bun.spawn> | undefined;
  const stopStarted = (tunnel?: ReturnType<typeof Bun.spawn>): void => {
    tunnel?.kill();
    stackChild?.kill();
  };
  if (await liveApi(apiOrigin)) {
    console.error(`using already-running API at ${apiOrigin}`);
  } else {
    stackChild = startNixStack(stack);
    let apiReady = false;
    const stopped = stackChild.exited.then((code) => {
      if (!apiReady) fail(`nix develop -c ${stack} exited ${String(code)} before the API became ready`);
    });
    await Promise.race([
      waitForLocalApi(apiOrigin, 900, `nix develop -c ${stack} did not become ready within 15 minutes.`),
      stopped,
    ]);
    apiReady = true;
  }
  const token = await mintSiweAccessToken(apiOrigin, signingKey);
  const tokenPath = `${stateDir}/bazantic-access.token`;
  await writeSecretFile(tokenPath, token);

  const existingTunnel = Bun.env["AQUA_TUNNEL_URL"]?.trim();
  let tunnelOrigin: string;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  if (existingTunnel !== undefined && existingTunnel.length > 0) {
    tunnelOrigin = existingTunnel.replace(/\/$/u, "");
  } else {
    const started = await startQuickTunnel(apiOrigin);
    tunnelOrigin = started.url;
    child = started.child;
  }

  try {
    await waitForPublicOrigin(tunnelOrigin);
    const created = gatewayAddSchema.parse(await runJson("baz", [
      "gateway", "add",
      "--spec-url", `${tunnelOrigin}/openapi.json`,
      "--endpoint", tunnelOrigin,
      "--name", GATEWAY_NAME,
      "--auth-type", "api-key",
      "--status", "draft",
      "--json",
    ]));
    const record = {
      id: created.id,
      slug: created.slug,
      mcpUrl: created.mcpUrl,
      tunnel: tunnelOrigin,
      apiOrigin,
      name: GATEWAY_NAME,
      tokenPath,
      dashboard: "https://bazantic.com",
      mcpJam: {
        http: { transport: "streamable-http", url: created.mcpUrl },
        stdio: {
          command: "bun",
          args: ["apps/mcp-bridge/src/main.ts"],
          env: {
            AQUA_API_URL: apiOrigin,
            AQUA_RPC_URL: envOr("AQUA_RPC_URL", "http://127.0.0.1:8545"),
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
      tunnel: tunnelOrigin,
      tokenPath,
      next: [
        "Open the Bazantic dashboard, set API key delivery to bearer, paste the token file, set prices, and activate.",
        "MCP Jam HTTP: add mcpUrl as Streamable HTTP after activation; tools/call returns 402.",
        "MCP Jam STDIO: bun apps/mcp-bridge/src/main.ts with AQUA_API_URL pointing at the local API and a hardware-AMR token.",
        "Keep this process running so the quick tunnel hostname stays valid.",
      ],
    }, null, 2));
    if (holdTunnel && (child !== undefined || stackChild !== undefined)) {
      const stop = (): void => {
        stopStarted(child);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      const waiters: Promise<number>[] = [];
      if (child !== undefined) waiters.push(child.exited);
      if (stackChild !== undefined) waiters.push(stackChild.exited);
      const code = await Promise.race(waiters);
      stopStarted(child);
      if (code !== 0 && code !== 143 && code !== 130) fail(`supervised process exited ${String(code)}`);
      return;
    }
    stopStarted(child);
  } catch (error) {
    stopStarted(child);
    throw error;
  }
};

if (import.meta.main) {
  try {
    await deploy();
  } catch {
    process.exit(1);
  }
}
