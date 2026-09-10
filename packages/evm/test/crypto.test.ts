import { describe, expect, test } from "bun:test";
import { addressSchema, hashSchema, hexSchema } from "@aqua/core";
import type { Eip712TypedData } from "../src/crypto.ts";
import {
  decodeOrder, encodeOrder, encodeX402ExactSettle, hashTypedData, initializeCubane, recoverPersonalAddress, recoverTypedDataAddress, selector, signPersonalMessage, signTypedData, signingKeyAddress,
} from "../src/index.ts";

const key = hexSchema.parse(`0x${"0".repeat(63)}1`);
const typedData: Eip712TypedData = {
  domain: {
    name: "Aqua test",
    version: "1",
    chainId: 1n,
    verifyingContract: addressSchema.parse("0x1111111111111111111111111111111111111111"),
  },
  types: { Authorization: [{ name: "owner", type: "address" }, { name: "amount", type: "uint256" }] },
  primaryType: "Authorization",
  message: { owner: addressSchema.parse("0x2222222222222222222222222222222222222222"), amount: 42n },
};

describe("Cubane EIP-712 signer", () => {
  test("derives, signs, hashes, and recovers without viem", () => {
    const address = signingKeyAddress(key);
    expect(address.toLowerCase()).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    const digest = hashTypedData(typedData);
    expect(hashSchema.parse(digest)).toBe(digest);
    const signature = signTypedData(key, typedData);
    expect(signature).toHaveLength(132);
    expect(recoverTypedDataAddress(typedData, signature).toLowerCase()).toBe(address.toLowerCase());
  });

  test("signs and recovers EIP-191 personal messages", () => {
    const address = signingKeyAddress(key);
    const signature = signPersonalMessage(key, "Sign in to Aqua Backend");
    expect(signature).toHaveLength(132);
    expect(recoverPersonalAddress("Sign in to Aqua Backend", signature).toLowerCase()).toBe(address.toLowerCase());
  });
});

describe("Cubane SwapVM order ABI", () => {
  test("encodes Order as a 1-tuple so SwapVM.hash of Cubane swap calldata matches the shipped strategy", () => {
    initializeCubane();
    const maker = addressSchema.parse("0x1111111111111111111111111111111111111111");
    const encoded = encodeOrder({ maker, traits: 1n << 254n, data: hexSchema.parse("0xabcd") });
    expect(encoded.slice(0, 66)).toBe(`0x${"20".padStart(64, "0")}`);
    expect(encoded.slice(66, 130)).toBe(maker.slice(2).padStart(64, "0"));
    expect(decodeOrder(encoded)).toEqual({ maker, traits: 1n << 254n, data: hexSchema.parse("0xabcd") });
  });
});

describe("Cubane x402 ABI", () => {
  test("encodes exact Permit2 settlement calldata", () => {
    const calldata = encodeX402ExactSettle(
      {
        permitted: { token: addressSchema.parse("0x3333333333333333333333333333333333333333"), amount: 10n },
        nonce: 11n, deadline: 12n,
      },
      addressSchema.parse("0x4444444444444444444444444444444444444444"),
      { to: addressSchema.parse("0x5555555555555555555555555555555555555555"), validAfter: 9n },
      hexSchema.parse("0x1234"),
    );
    expect(calldata.slice(0, 10)).toBe(selector("settle(((address,uint256),uint256,uint256),address,(address,uint256),bytes)") );
    expect(calldata).toBe("0x13cd3b530000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000b000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000444444444444444444444444444444444444444400000000000000000000000055555555555555555555555555555555555555550000000000000000000000000000000000000000000000000000000000000009000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000021234000000000000000000000000000000000000000000000000000000000000");
  });
});
