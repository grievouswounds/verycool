import { describe, expect, test } from "bun:test";
import { calculateLimitAmounts } from "../src/index.ts";

describe("maker-favouring decimal price conversion", () => {
  test("rounds quote received up for a base-denominated sell", () => {
    expect(calculateLimitAmounts("sell", { denomination: "base", amount: "1.000001" }, "1.000001", 6, 6)).toEqual({
      baseUnits: 1_000_001n,
      quoteUnits: 1_000_003n,
    });
  });

  test("rounds quote paid down for a base-denominated buy", () => {
    expect(calculateLimitAmounts("buy", { denomination: "base", amount: "1.000001" }, "1.000001", 6, 6)).toEqual({
      baseUnits: 1_000_001n,
      quoteUnits: 1_000_002n,
    });
  });

  test("never uses exponent notation or floating point", () => {
    expect(() => calculateLimitAmounts("sell", { denomination: "base", amount: "1e6" }, "2", 18, 6)).toThrow();
  });
});
