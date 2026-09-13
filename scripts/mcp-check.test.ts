import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertHardwareAmrPath,
  MCP_CHECK_OAUTH_REUSE_ENV,
  missingRequiredAquaTools,
  oauthCacheIsFresh,
  parseMcpCheckMode,
} from "./mcp-check.ts";

describe("mcp-check helpers", () => {
  test("accepts hosted, bridge, and all modes", () => {
    expect(parseMcpCheckMode("hosted")).toBe("hosted");
    expect(parseMcpCheckMode("bridge")).toBe("bridge");
    expect(parseMcpCheckMode("all")).toBe("all");
    expect(() => parseMcpCheckMode("gateway")).toThrow();
  });

  test("matches required tools by canonical snake_case names", () => {
    expect(missingRequiredAquaTools([
      "request_trade", "post_trade", "get_trades", "cancel_trade",
      "subscribe_to_user", "unsubscribe_from_user", "wipe_subscribed_trades", "get_balances",
    ])).toEqual([]);
    expect(missingRequiredAquaTools(["request_trade"])).toContain("cancel_trade");
  });

  test("treats a missing or expired oauth.json as not fresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aqua-mcp-check-"));
    expect(await oauthCacheIsFresh(join(dir, "oauth.json"))).toBe(false);
    await writeFile(join(dir, "oauth.json"), JSON.stringify({
      resource: "http://localhost:8787",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
    }));
    expect(await oauthCacheIsFresh(join(dir, "oauth.json"))).toBe(true);
    expect(await oauthCacheIsFresh(join(dir, "oauth.json"), Date.now() + 200_000)).toBe(false);
  });

  test("stdio bridge checks reuse a warm oauth.json instead of Knock", () => {
    expect(MCP_CHECK_OAUTH_REUSE_ENV).toEqual(["-e", "AQUA_OAUTH_REUSE_CACHE=1"]);
  });

  test("refuses the SIWE access-token override", () => {
    expect(() => {
      assertHardwareAmrPath({ AQUA_ACCESS_TOKEN: "paseto" });
    }).toThrow(/AQUA_ACCESS_TOKEN/);
    expect(() => {
      assertHardwareAmrPath({});
    }).not.toThrow();
  });
});
