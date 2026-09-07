import { describe, expect, test } from "bun:test";
import { addressSchema, hashSchema, hexSchema } from "@aqua/core";
import { encodeOrder } from "@aqua/evm";
import { AQUA_EVENT_TOPICS, buildLimitProgram, decodeProtocolEvent, recognizeLimitStrategy } from "../src/index.ts";

const hash = hashSchema.parse(`0x${"00".repeat(32)}`);

describe("strict Aqua event and strategy grammar", () => {
  test("decodes the pinned SDK Shipped vector", () => {
    const event = decodeProtocolEvent({
      address: addressSchema.parse("0x774d0b2991e1af5303ea6c054c78fa856d0f550c"), topics: [AQUA_EVENT_TOPICS.shipped],
      data: hexSchema.parse("0x000000000000000000000000961da14c99217789106f0c246c0f66b49fe266ff000000000000000000000000774d0b2991e1af5303ea6c054c78fa856d0f550c2d142ba44ee9104f8cd702bfe7520e64eb8531c5e4e4ded80c6a93cf5a3d113e000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000961da14c99217789106f0c246c0f66b49fe266ff10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000001e1504000186a010001414535441424c452d313736323837313434373737300000"),
      blockNumber: 1n, blockHash: hash, transactionHash: hash, logIndex: 0n,
    });
    expect(event.kind).toBe("shipped");
    if (event.kind === "shipped") expect(event.maker).toBe(addressSchema.parse("0x961da14c99217789106f0c246c0f66b49fe266ff"));
  });

  test("recognizes only the exact backend limit program", () => {
    const maker = addressSchema.parse("0x1111111111111111111111111111111111111111");
    const sellToken = addressSchema.parse("0x2222222222222222222222222222222222222222");
    const buyToken = addressSchema.parse("0x3333333333333333333333333333333333333333");
    const data = buildLimitProgram({ sellToken, buyToken, sellAmount: 10n, buyAmount: 25n, expiresAtSeconds: 100n, salt: hash, fill: { type: "partial" } });
    const strategy = recognizeLimitStrategy(encodeOrder({ maker, traits: 0n, data }));
    expect(strategy.sellAmount).toBe(10n);
    expect(strategy.buyAmount).toBe(25n);
  });
});
