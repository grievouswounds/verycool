import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const tokenSchema = z.object({
  access_token: z.string().min(1), token_type: z.literal("Bearer"), expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1), scope: z.string().min(1),
}).strict();
const stateSchema = z.object({
  clientId: z.string().min(1), resource: z.url(), refreshToken: z.string().min(1),
  accessToken: z.string().min(1), expiresAt: z.number().int().positive(),
}).strict();
type OAuthState = z.infer<typeof stateSchema>;

const json = async (response: Response): Promise<unknown> => {
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`OAuth ${String(response.status)}: ${JSON.stringify(body)}`);
  return body;
};
const save = async (path: string, state: OAuthState): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
};
const load = async (path: string): Promise<OAuthState | null> => {
  try { return stateSchema.parse(JSON.parse(await readFile(path, "utf8"))); } catch { return null; }
};
const tokenRequest = async (apiUrl: string, values: Readonly<Record<string, string>>): Promise<z.infer<typeof tokenSchema>> => {
  const response = await fetch(new URL("/token", apiUrl), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values),
  });
  return tokenSchema.parse(await json(response));
};
const launchBrowser = (url: string): void => {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  void child.exited.catch(() => undefined);
  console.error(`Complete Ledger OAuth in your browser: ${url}`);
};

export const oauthAccessToken = async (apiUrl: string, cachePath: string, callbackPort: number): Promise<string> => {
  const override = Bun.env["AQUA_ACCESS_TOKEN"];
  if (override !== undefined && override.length > 0) return override;
  const metadata = z.object({ resource: z.url(), authorization_servers: z.array(z.url()).min(1) }).loose().parse(
    await json(await fetch(new URL("/.well-known/oauth-protected-resource", apiUrl))),
  );
  const issuer = metadata.authorization_servers[0];
  if (issuer === undefined) throw new Error("OAuth protected-resource metadata has no authorization server");
  const cached = await load(cachePath);
  if (cached?.resource === metadata.resource && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
  if (cached?.resource === metadata.resource) {
    try {
      const refreshed = await tokenRequest(issuer, { grant_type: "refresh_token", refresh_token: cached.refreshToken, client_id: cached.clientId, resource: cached.resource });
      const next = { clientId: cached.clientId, resource: cached.resource, refreshToken: refreshed.refresh_token, accessToken: refreshed.access_token, expiresAt: Date.now() + refreshed.expires_in * 1000 };
      await save(cachePath, next); return next.accessToken;
    } catch { /* An expired or consumed refresh token falls through to interactive OAuth. */ }
  }

  const redirectUri = `http://127.0.0.1:${String(callbackPort)}/callback`;
  const registration = z.object({ client_id: z.string().min(1) }).loose().parse(await json(await fetch(new URL("/register", issuer), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], scope: "trading:read trading:write activity:read activity:write" }),
  })));
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const expectedState = randomBytes(32).toString("base64url");
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const callback = Bun.serve({ hostname: "127.0.0.1", port: callbackPort, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
    const receivedState = url.searchParams.get("state"); const authorizationCode = url.searchParams.get("code");
    if (receivedState !== expectedState || authorizationCode === null) {
      rejectCode(new Error("OAuth callback state or authorization code is invalid"));
      return new Response("Authorization failed. You may close this window.", { status: 400 });
    }
    resolveCode(authorizationCode);
    return new Response("Ledger authorization complete. You may close this window.", { headers: { "content-type": "text/plain; charset=utf-8" } });
  } });
  const authorize = new URL("/authorize", issuer);
  for (const [name, value] of Object.entries({ client_id: registration.client_id, redirect_uri: redirectUri, resource: metadata.resource, scope: "trading:read trading:write activity:read activity:write", state: expectedState, code_challenge: challenge, code_challenge_method: "S256", response_type: "code" })) authorize.searchParams.set(name, value);
  launchBrowser(authorize.toString());
  const timer = setTimeout(() => { rejectCode(new Error("Ledger OAuth authorization timed out")); }, 300_000);
  let authorizationCode: string;
  try { authorizationCode = await code; } finally { clearTimeout(timer); await callback.stop(true); }
  const tokens = await tokenRequest(issuer, { grant_type: "authorization_code", code: authorizationCode, client_id: registration.client_id, redirect_uri: redirectUri, resource: metadata.resource, code_verifier: verifier });
  const state = { clientId: registration.client_id, resource: metadata.resource, refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  await save(cachePath, state); return state.accessToken;
};
