import { describe, expect, test } from "bun:test";
import { addressSchema } from "@aqua/core";
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

  test("accepts string JSON-RPC ids from public endpoints", async () => {
    const fetcher = async (): Promise<Response> => Response.json({ jsonrpc: "2.0", id: "1", result: "0xaa36a7" });
    const client = new JsonRpcClient(new URL("http://rpc.invalid"), 100, fetcher);
    expect(await client.chainId()).toBe(11_155_111);
  });

  test("normalizes empty account code returned as 0x00", async () => {
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method === "eth_getCode") return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x00" });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x1" });
    };
    const client = new JsonRpcClient(new URL("http://rpc.invalid"), 100, fetcher);
    expect(await client.getCode(addressSchema.parse(`0x${"11".repeat(20)}`))).toBe("0x");
  });
});
