import { describe, expect, test } from "bun:test";
import { bindFixtureToken } from "../src/fixture-bind.ts";
import type { Address } from "@aqua/core";

const tokens = [
  { address: "0x019799b067422517212ce754f96d4faa6cc6a090" as Address, symbol: "aUSD" },
  { address: "0x0bb3844e65962a303bc4cabdd4b742a324f2f570" as Address, symbol: "aETH" },
];

describe("stdio request_trade fixture bind", () => {
  test("turns aUSD search into the Sepolia fixture address", () => {
    expect(bindFixtureToken({ type: "search", query: "aUSD" }, tokens)).toEqual({
      type: "address",
      address: "0x019799b067422517212ce754f96d4faa6cc6a090",
    });
  });
});
