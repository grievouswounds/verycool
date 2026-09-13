import { describe, expect, test } from "bun:test";
import { matchFixtureTokens } from "../src/fixture-search.ts";

const tokens = [
  { address: "0x019799b067422517212ce754f96d4faa6cc6a090", symbol: "aUSD" },
  { address: "0x0bb3844e65962a303bc4cabdd4b742a324f2f570", symbol: "aETH" },
] as const;

describe("fixture token search", () => {
  test("resolves aUSD without calling 1inch", () => {
    expect(matchFixtureTokens(tokens, "aUSD")).toEqual([tokens[0]]);
  });

  test("is case-insensitive", () => {
    expect(matchFixtureTokens(tokens, "aeth")).toEqual([tokens[1]]);
  });

  test("returns nothing for unknown symbols so 1inch can still run", () => {
    expect(matchFixtureTokens(tokens, "USDC")).toEqual([]);
  });
});
