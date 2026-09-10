import { describe, expect, test } from "bun:test";
import { hexSchema } from "@aqua/core";
import { signingKeyAddress } from "@aqua/evm";

describe("print-signer-identities helpers", () => {
  test("Anvil account 0 maps to the well-known address", () => {
    const key = hexSchema.parse("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    expect(signingKeyAddress(key).toLowerCase()).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });
});
