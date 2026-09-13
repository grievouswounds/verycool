import { describe, expect, test } from "bun:test";
import { shouldReuseOauthCache } from "../src/oauth-reuse.ts";

describe("stdio OAuth cache reuse", () => {
  test("forces a Security Key ceremony on a new process by default", () => {
    expect(shouldReuseOauthCache({}, { completed: false })).toBe(false);
  });

  test("reuses the in-process token after the connect ceremony", () => {
    expect(shouldReuseOauthCache({}, { completed: true })).toBe(true);
  });

  test("lets mcp-check reuse a warm on-disk cache without Knock", () => {
    expect(shouldReuseOauthCache({ AQUA_OAUTH_REUSE_CACHE: "1" }, { completed: false })).toBe(true);
  });

  test("does not treat AQUA_E2E=1 as permission to skip the connect ceremony", () => {
    expect(shouldReuseOauthCache({ AQUA_E2E: "1" }, { completed: false })).toBe(false);
  });
});
