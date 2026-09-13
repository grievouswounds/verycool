import { describe, expect, test } from "bun:test";
import { bufferedGasLimit, shouldSkipTokenApprove } from "../src/gas.ts";

describe("bufferedGasLimit", () => {
  test("pads a warm approve estimate above a cold 46k fill", () => {
    expect(bufferedGasLimit(26_240n)).toBeGreaterThan(46_000n);
  });

  test("gives a 99-percent-used 46k success case headroom", () => {
    const padded = bufferedGasLimit(46_180n);
    expect(padded).toBeGreaterThan((46_180n * 100n) / 99n);
  });
});

describe("shouldSkipTokenApprove", () => {
  test("skips when Permit2 allowance already covers 1e6 units", () => {
    expect(shouldSkipTokenApprove({ allowance: 1_000_000n, required: 1_000_000n })).toBe(true);
  });

  test("does not skip when allowance is zero", () => {
    expect(shouldSkipTokenApprove({ allowance: 0n, required: 1_000_000n })).toBe(false);
  });
});
