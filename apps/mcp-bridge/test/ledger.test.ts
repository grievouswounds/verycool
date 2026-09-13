import { describe, expect, test } from "bun:test";
import { genuineCheckRequired, rewriteGenuineCheckFailure } from "../src/genuine-check.ts";
import { joinLedgerSignature } from "../src/ledger.ts";

describe("Ledger signature encoding", () => {
  test("normalizes compact recovery ids and pads r/s", () => {
    expect(String(joinLedgerSignature({ r: "0x1", s: "0x2", v: 1 }))).toBe(`0x${"0".repeat(63)}1${"0".repeat(63)}21c`);
  });
});

describe("genuine-check policy", () => {
  test("runs the first call and skips later successes in the same process", () => {
    const state = { passed: false };
    expect(genuineCheckRequired(state, undefined)).toBe(true);
    state.passed = true;
    expect(genuineCheckRequired(state, undefined)).toBe(false);
  });

  test("skips when AQUA_E2E=1 even before the first success", () => {
    expect(genuineCheckRequired({ passed: false }, "1")).toBe(false);
  });

  test("rewrites wrong_app to dashboard quit instructions", () => {
    const message = rewriteGenuineCheckFailure("error: wrong_app\n");
    expect(message).toContain("wrong_app");
    expect(message.toLowerCase()).toContain("dashboard");
    expect(message.toLowerCase()).toContain("quit");
    expect(message.toLowerCase()).toContain("do not open ethereum until");
  });
});
