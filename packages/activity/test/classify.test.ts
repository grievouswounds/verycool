import { describe, expect, test } from "bun:test";
import { addressSchema, hashSchema } from "@aqua/core";
import { classifyTransfers } from "../src/index.ts";

const watched = addressSchema.parse("0x1111111111111111111111111111111111111111");
const peer = addressSchema.parse("0x2222222222222222222222222222222222222222");
const tokenA = addressSchema.parse("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const tokenB = addressSchema.parse("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const transactionHash = hashSchema.parse(`0x${"11".repeat(32)}`);

describe("ERC-20 action classification", () => {
  test("classifies opposite token counterflows conservatively as a trade", () => {
    const actions = classifyTransfers(watched, [
      { token: tokenA, from: watched, to: peer, amount: 10n, transactionHash, logIndex: 1n },
      { token: tokenB, from: peer, to: watched, amount: 20n, transactionHash, logIndex: 2n },
    ]);
    expect(actions.map((action) => action.classification)).toEqual(["sell", "buy"]);
    expect(actions.every((action) => action.classificationSource === "inferredCounterflow")).toBe(true);
  });

  test("does not call an isolated incoming transfer a buy", () => {
    const [action] = classifyTransfers(watched, [
      { token: tokenA, from: peer, to: watched, amount: 10n, transactionHash, logIndex: 1n },
    ]);
    expect(action?.classification).toBe("received");
  });

  test("recognizes mint, burn, and self-transfer semantics", () => {
    const zero = addressSchema.parse("0x0000000000000000000000000000000000000000");
    const actions = classifyTransfers(watched, [
      { token: tokenA, from: zero, to: watched, amount: 1n, transactionHash, logIndex: 1n },
      { token: tokenA, from: watched, to: zero, amount: 1n, transactionHash, logIndex: 2n },
      { token: tokenA, from: watched, to: watched, amount: 1n, transactionHash, logIndex: 3n },
    ]);
    expect(actions.map((action) => action.classification)).toEqual(["minted", "burned", "selfTransfer"]);
  });
});
