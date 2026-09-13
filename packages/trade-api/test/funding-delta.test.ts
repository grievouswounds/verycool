import { describe, expect, test } from "bun:test";
import { fundingConfirmation } from "../src/funding-delta.ts";

describe("settlement funding confirmation", () => {
  test("treats a missing receipt and zero delta as still pending, not a token-balance failure", () => {
    expect(fundingConfirmation({ receipt: "missing", delta: 0n, expected: 1_000_000n })).toBe("pending");
  });

  test("accepts an exact delta even before the receipt is visible", () => {
    expect(fundingConfirmation({ receipt: "missing", delta: 1_000_000n, expected: 1_000_000n })).toBe("exact");
  });

  test("rejects a confirmed reverted settlement", () => {
    expect(fundingConfirmation({ receipt: "reverted", delta: 0n, expected: 1_000_000n })).toBe("mismatch");
  });

  test("keeps polling when the receipt is success but the vault eth_call is still stale", () => {
    expect(fundingConfirmation({ receipt: "success", delta: 0n, expected: 1_000_000n })).toBe("pending");
  });

  test("rejects a terminal success whose vault delta is still wrong", () => {
    expect(fundingConfirmation({ receipt: "success", delta: 0n, expected: 1_000_000n, terminal: true })).toBe("mismatch");
  });
});
