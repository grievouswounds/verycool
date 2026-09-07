import { describe, expect, test } from "bun:test";
import { parseTokenAmount } from "../src/index.ts";

describe("canonical token decimal language", () => {
  test("converts a decimal token amount without floating point arithmetic", () => {
    expect(parseTokenAmount("12.345", 6)).toBe(12_345_000n);
  });

  test("rejects exponent notation and excess precision", () => {
    expect(() => parseTokenAmount("1e3", 18)).toThrow();
    expect(() => parseTokenAmount("0.0000001", 6)).toThrow();
  });
});
