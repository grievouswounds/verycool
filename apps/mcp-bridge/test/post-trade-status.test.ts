import { describe, expect, test } from "bun:test";
import { awaitingDelegation } from "../src/post-trade-status.ts";

describe("post_trade continuation", () => {
  test("returns the same preview handles after a Ledger delegation broadcast", () => {
    const body = awaitingDelegation("f299751a-bb13-4650-b34d-3973580b478b", "0xabc", "0xdef");
    expect(body["status"]).toBe("awaiting_delegation");
    expect(body["previewId"]).toBe("f299751a-bb13-4650-b34d-3973580b478b");
    expect(body["next"]).toContain("post_trade");
  });
});
