import { describe, expect, test } from "bun:test";
import { corsAllowOrigin, jsonRpcId, mcpUnauthorized } from "../src/cors.ts";

describe("MCP OAuth CORS", () => {
  test("reflects native-scheme Origin and otherwise uses *", () => {
    expect(corsAllowOrigin("cursor://anysphere.cursor-mcp")).toBe("cursor://anysphere.cursor-mcp");
    expect(corsAllowOrigin("vscode://vscode.github-authentication")).toBe("vscode://vscode.github-authentication");
    expect(corsAllowOrigin("https://app.mcpjam.com")).toBe("*");
    expect(corsAllowOrigin(null)).toBe("*");
  });

  test("echoes JSON-RPC id on 401", () => {
    const response = mcpUnauthorized("https://vercel-henna-gamma-46.vercel.app", new Request("https://vercel-henna-gamma-46.vercel.app/mcp", { headers: { origin: "https://app.mcpjam.com" } }), { jsonrpc: "2.0", id: 7, method: "initialize" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate");
  });

  test("uses null JSON-RPC id when the body has none", () => {
    expect(jsonRpcId({ method: "initialize" })).toBeNull();
    expect(jsonRpcId({ id: "abc" })).toBe("abc");
  });
});
