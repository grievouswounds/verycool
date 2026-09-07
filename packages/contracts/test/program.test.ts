import { describe, expect, test } from "bun:test";
import { buildLimitProgram, decodeProgram } from "../src/index.ts";
import { addressSchema, hexSchema } from "@aqua/core";

describe("LimitSwapVM v1.0.2 programs", () => {
  test("orders partial instructions before the limit computation", () => {
    const program = buildLimitProgram({
      sellToken: addressSchema.parse("0x1111111111111111111111111111111111111111"),
      buyToken: addressSchema.parse("0x2222222222222222222222222222222222222222"),
      sellAmount: 100n, buyAmount: 200n, expiresAtSeconds: 2_000_000_000n,
      salt: hexSchema.parse(`0x${"11".repeat(32)}`), fill: { type: "partial" },
    });
    expect(decodeProgram(program).map((item) => item.opcode)).toEqual([14, 31, 18, 21, 22]);
  });

  test("uses the bitmap and full-fill opcodes", () => {
    const program = buildLimitProgram({
      sellToken: addressSchema.parse("0x1111111111111111111111111111111111111111"),
      buyToken: addressSchema.parse("0x2222222222222222222222222222222222222222"),
      sellAmount: 100n, buyAmount: 200n, expiresAtSeconds: 2_000_000_000n,
      salt: hexSchema.parse(`0x${"11".repeat(32)}`), fill: { type: "allOrNothing", nonce: 42 },
    });
    expect(decodeProgram(program).map((item) => item.opcode)).toEqual([14, 31, 18, 19, 23]);
  });
});
