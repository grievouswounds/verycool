import { describe, expect, test } from "bun:test";
import { addressSchema, hexSchema } from "@aqua/core";
import { CubaneTransactionSigner, initializeCubane } from "../src/index.ts";

describe("Cubane EIP-1559 transaction signing", () => {
  test("produces deterministic typed transaction bytes without exposing the key", () => {
    initializeCubane();
    const signer = new CubaneTransactionSigner(hexSchema.parse(`0x${"01".repeat(32)}`));
    const transaction = {
      chainId: 1n, nonce: 0n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n,
      gas: 21_000n, to: addressSchema.parse("0x1111111111111111111111111111111111111111"), value: 1n,
      data: hexSchema.parse("0x"),
    };
    const first = signer.sign(transaction); const second = signer.sign(transaction);
    expect(first).toBe(second); expect(first.startsWith("0x02")).toBeTrue(); expect(first.length).toBeGreaterThan(100);
  });
});
