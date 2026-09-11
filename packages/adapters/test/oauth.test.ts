import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OAUTH_SCOPE,
  authorizationRedirectWithIss,
  oauthRedirectAllowed,
  oauthRedirectMatches,
  oauthResourceAllowed,
  oauthScopeOrDefault,
} from "../src/oauth.ts";

describe("OAuth client and redirect rules", () => {
  test("allows HTTPS and any-port loopback including IPv6", () => {
    expect(oauthRedirectAllowed("https://app.mcpjam.com/oauth/callback")).toBe(true);
    expect(oauthRedirectAllowed("http://127.0.0.1:41739/callback")).toBe(true);
    expect(oauthRedirectAllowed("http://localhost:9/cb")).toBe(true);
    expect(oauthRedirectAllowed("http://[::1]:12/callback")).toBe(true);
    expect(oauthRedirectAllowed("http://example.com/cb")).toBe(false);
    expect(oauthRedirectAllowed("cursor://oauth")).toBe(false);
  });

  test("matches loopback by host and path regardless of port", () => {
    expect(oauthRedirectMatches("http://127.0.0.1:1/callback", "http://127.0.0.1:9999/callback")).toBe(true);
    expect(oauthRedirectMatches("http://[::1]:1/callback", "http://[::1]:2/callback")).toBe(true);
    expect(oauthRedirectMatches("http://127.0.0.1:1/a", "http://127.0.0.1:1/b")).toBe(false);
    expect(oauthRedirectMatches("https://app.mcpjam.com/cb", "https://app.mcpjam.com/cb")).toBe(true);
    expect(oauthRedirectMatches("https://app.mcpjam.com/cb", "https://app.mcpjam.com/other")).toBe(false);
  });

  test("allowlists origin and origin/mcp without normalizing stored values", () => {
    const origin = "https://vercel-henna-gamma-46.vercel.app";
    expect(oauthResourceAllowed(origin, origin)).toBe(true);
    expect(oauthResourceAllowed(origin, `${origin}/mcp`)).toBe(true);
    expect(oauthResourceAllowed(origin, `${origin}/other`)).toBe(false);
  });

  test("defaults empty authorize and DCR scopes", () => {
    expect(oauthScopeOrDefault(undefined)).toBe(DEFAULT_OAUTH_SCOPE);
    expect(oauthScopeOrDefault("")).toBe(DEFAULT_OAUTH_SCOPE);
    expect(oauthScopeOrDefault("trading:read")).toBe("trading:read");
  });

  test("appends RFC 9207 iss on the authorization redirect", () => {
    const redirect = authorizationRedirectWithIss("http://127.0.0.1:41739/callback", "abc", "state-value-123456", "https://vercel-henna-gamma-46.vercel.app");
    const url = new URL(redirect);
    expect(url.searchParams.get("code")).toBe("abc");
    expect(url.searchParams.get("state")).toBe("state-value-123456");
    expect(url.searchParams.get("iss")).toBe("https://vercel-henna-gamma-46.vercel.app");
  });
});
