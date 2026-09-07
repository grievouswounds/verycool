import { describe, expect, test } from "bun:test";
import { initializeCubane, JsonRpcClient, selector } from "../src/index.ts";

describe("Cubane EVM boundary", () => {
  test("initializes JavaScript cryptography and passes startup vectors", () => {
    expect(() => { initializeCubane(); }).not.toThrow();
  });

  test("computes the canonical ERC-20 approve selector", () => {
    expect(String(selector("approve(address,uint256)"))).toBe("0x095ea7b3");
  });

  test("validates JSON-RPC chain IDs", async () => {
    const fetcher = async (): Promise<Response> => Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
    const client = new JsonRpcClient(new URL("http://rpc.invalid"), 100, fetcher);
    expect(await client.chainId()).toBe(1);
  });
});
