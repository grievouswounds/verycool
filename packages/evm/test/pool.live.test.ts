import { describe, expect, test } from "bun:test";
import { ETHEREUM_SEPOLIA_CHAIN_ID, createPooledRpcClient, endpointsForChain } from "../src/index.ts";

describe("live Sepolia admission", () => {
  test("admits at least one registry endpoint", async () => {
    if (Bun.env["AQUA_RPC_SMOKE"] !== "1") return;
    const registry = endpointsForChain(ETHEREUM_SEPOLIA_CHAIN_ID);
    expect(registry.length).toBeGreaterThan(0);
    const first = registry[0];
    if (first === undefined) throw new Error("Sepolia registry is empty");
    const rpc = createPooledRpcClient({ id: ETHEREUM_SEPOLIA_CHAIN_ID, rpcUrl: first.url }, 8_000);
    expect(await rpc.chainId()).toBe(ETHEREUM_SEPOLIA_CHAIN_ID);
    expect(rpc.snapshot().healthy).toBeGreaterThan(0);
  }, 60_000);
});
