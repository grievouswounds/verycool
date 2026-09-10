import { describe, expect, test } from "bun:test";
import { addressSchema, runtimeManifestSchema } from "@aqua/core";
import { keccakHex } from "@aqua/evm";

describe("local deployment policy", () => {
  test("pins canonical Permit2 and x402 addresses and exact keeper selectors", async () => {
    const source = await Bun.file("scripts/deploy-local-chain.ts").text();
    expect(source).toContain("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(source).toContain("0x402085c248eea27d92e8b30b2c58ed07f9e20001");
    expect(source).toContain("467f0000000000000000000000000000000000000000000000000000000000007a69");
    expect(source).toContain("467f0000000000000000000000000000000000000000000000000000000000000001");
    expect(source).toContain('const SWAP_SELECTOR = "0xf4d2d412"');
    expect(keccakHex(new TextEncoder().encode("observe(bytes32,bytes32,bool)")).slice(0, 10)).toBe("0xb1b0923a");
    expect(keccakHex(new TextEncoder().encode("activate(bytes32,bytes32,bytes32)")).slice(0, 10)).toBe("0x5f330b0f");
    expect(keccakHex(new TextEncoder().encode("execute((address,uint8,bytes,address[],uint256[],bytes32,uint256),bytes)")).slice(0, 10)).toBe("0x95d5857e");
    expect(keccakHex(new TextEncoder().encode("execute(address[],bytes[])")).slice(0, 10)).toBe("0xc8d18a45");
    expect(keccakHex(new TextEncoder().encode("registerDelegation(address,address,address,uint128,uint128,uint64,bytes)")).slice(0, 10)).toBe("0xeeabec06");
    expect(keccakHex(new TextEncoder().encode("deployVault(address,address,address,address,address,bytes32)")).slice(0, 10)).toBe("0xf15d634f");
  });

  test("requires BoundedMatcher and permits both fixture pair directions", () => {
    const contract = (digit: string) => ({ address: addressSchema.parse(`0x${digit.repeat(40)}`), runtimeCodeHash: `0x${digit.repeat(64)}` });
    const input = {
      schemaVersion: 1, profile: "local-anvil", runId: crypto.randomUUID(), createdAt: new Date().toISOString(),
      chain: { id: 31337, rpcUrl: "http://127.0.0.1:8545", genesisHash: `0x${"1".repeat(64)}`, deploymentBlock: "1" },
      services: { databaseUrl: "postgresql://aqua@127.0.0.1/aqua", apiUrl: "http://localhost:8787", facilitatorUrl: "http://localhost:8788", brokerSocket: "/tmp/aqua.sock" },
      auth: { issuer: "http://localhost:8787", resource: "http://localhost:8787", rpId: "localhost", origin: "http://localhost:8787", pasetoPublicKeys: [`k4.public.${"a".repeat(43)}`] },
      contracts: { aqua: contract("1"), aquaSwapRouter: contract("2"), limitSwapRouter: contract("3"), wrappedNativeToken: contract("4"), intentController: contract("5"), orderVaultFactory: contract("6"), boundedMatcher: contract("7"), permit2: contract("8"), x402ExactPermit2Proxy: contract("9") },
      fixtures: { tokens: [{ ...contract("a"), symbol: "aUSD", decimals: 6 }, { ...contract("b"), symbol: "aETH", decimals: 18 }], pairs: [{ baseToken: contract("a").address, quoteToken: contract("b").address }, { baseToken: contract("b").address, quoteToken: contract("a").address }] },
      indexer: { contracts: [contract("1").address], startBlock: "1", confirmations: 1 },
      keeper: { allowedTargets: [contract("5").address, contract("6").address, contract("7").address], allowedSelectors: ["0xb1b0923a", "0x5f330b0f", "0x95d5857e", "0xc8d18a45", "0xeeabec06", "0xf15d634f"] },
      secrets: { agent: "broker://agent", facilitator: "broker://facilitator", keeper: "broker://keeper", paseto: "broker://paseto" },
    };
    expect(runtimeManifestSchema.parse(input).contracts.boundedMatcher.address).toBe(contract("7").address);
    expect(runtimeManifestSchema.parse(input).fixtures.pairs).toHaveLength(2);
  });
});
