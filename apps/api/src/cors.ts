const NATIVE_ORIGIN = /^(?:cursor|vscode|vscode-webview|claude):/u;

export const MCP_OAUTH_CORS_PATHS = new Set([
  "/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/mcp/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/register",
  "/token",
]);

export const corsAllowOrigin = (requestOrigin: string | null): string =>
  requestOrigin !== null && NATIVE_ORIGIN.test(requestOrigin) ? requestOrigin : "*";

export const applyMcpCors = (response: Response, request: Request): Response => {
  response.headers.set("access-control-allow-origin", corsAllowOrigin(request.headers.get("origin")));
  response.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  response.headers.set("access-control-allow-headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
  if (response.headers.has("www-authenticate")) response.headers.set("access-control-expose-headers", "WWW-Authenticate");
  return response;
};

export const mcpCorsPreflight = (request: Request): Response => {
  const response = new Response(null, { status: 204 });
  return applyMcpCors(response, request);
};

export const jsonRpcId = (body: unknown): string | number | null => {
  if (typeof body !== "object" || body === null || !("id" in body)) return null;
  const id = body.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
};

export const mcpUnauthorized = (origin: string, request: Request, body: unknown, status: 401 | 405 = 401): Response => {
  const metadata = `${origin.replace(/\/$/u, "")}/.well-known/oauth-protected-resource/mcp`;
  const response = Response.json(
    { jsonrpc: "2.0", id: jsonRpcId(body), error: { code: -32001, message: "Unauthorized" } },
    {
      status,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${metadata}"`,
        ...(status === 405 ? { allow: "POST, OPTIONS" } : {}),
      },
    },
  );
  return applyMcpCors(response, request);
};
