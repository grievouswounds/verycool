import { describe, expect, test } from "bun:test";
import { addressSchema } from "@aqua/core";
import { randomSigningKey, signingKeyAddress } from "@aqua/evm";
import { parseAgentKek, unwrapAgentKey, wrapAgentKey } from "../src/agent-vault.ts";

describe("AgentVault wrap", () => {
  test("round-trips a 32-byte key under AQUA1 AES-GCM", () => {
    const kek = parseAgentKek("11".repeat(32));
    const owner = addressSchema.parse(`0x${"22".repeat(20)}`);
    const key = randomSigningKey();
    const wrapped = wrapAgentKey(kek, owner, key);
    expect(wrapped.subarray(0, 5).toString()).toBe("AQUA1");
    expect(unwrapAgentKey(kek, owner, wrapped)).toBe(key);
    expect(signingKeyAddress(unwrapAgentKey(kek, owner, wrapped))).toBe(signingKeyAddress(key));
  });

  test("rejects a kek that is not 32 bytes", () => {
    expect(() => parseAgentKek("aa")).toThrow(/32 bytes/);
    expect(() => parseAgentKek("")).toThrow(/missing/);
  });
});
