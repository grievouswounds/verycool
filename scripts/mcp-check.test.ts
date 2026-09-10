import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertHardwareAmrPath,
  missingRequiredAquaTools,
  oauthCacheIsFresh,
  parseMcpCheckMode,
} from "./mcp-check.ts";

describe("mcp-check helpers", () => {
  test("accepts gateway, bridge, and all modes", () => {
    expect(parseMcpCheckMode("gateway")).toBe("gateway");
    expect(parseMcpCheckMode("bridge")).toBe("bridge");
    expect(parseMcpCheckMode("all")).toBe("all");
    expect(() => parseMcpCheckMode("pay")).toThrow();
  });

  test("matches required tools through the Bazantic alias table", () => {
    expect(missingRequiredAquaTools([
      "requestTrade", "postTrade", "getTrades", "createTradeCancellation",
      "subscribeToUser", "unsubscribeFromUser", "wipeSubscribedTrades",
    ])).toEqual([]);
    expect(missingRequiredAquaTools(["requestTrade"])).toContain("cancel_trade");
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

  test("refuses the SIWE access-token override", () => {
    expect(() => assertHardwareAmrPath({ AQUA_ACCESS_TOKEN: "paseto" })).toThrow(/AQUA_ACCESS_TOKEN/);
    expect(() => assertHardwareAmrPath({})).not.toThrow();
  });
});
