import { describe, expect, test } from "bun:test";
import { joinLedgerSignature } from "../src/ledger.ts";

describe("Ledger signature encoding", () => {
  test("normalizes compact recovery ids and pads r/s", () => {
    expect(String(joinLedgerSignature({ r: "0x1", s: "0x2", v: 1 }))).toBe(`0x${"0".repeat(63)}1${"0".repeat(63)}21c`);
  });
});
