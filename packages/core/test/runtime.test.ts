import { describe, expect, test } from "bun:test";
import { parseRuntimeManifest, runtimeManifestHash, runtimeManifestSchema } from "../src/runtime.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const contract = (digit: string) => ({ address: address(digit), runtimeCodeHash: hash(digit) });

const manifest = runtimeManifestSchema.parse({
  schemaVersion: 1, profile: "local-anvil", runId: "7b4df39d-33e8-41d2-9206-c8786f290dab",
  createdAt: "2026-09-07T10:00:00.000Z",
  chain: { id: 31337, rpcUrl: "http://127.0.0.1:8546", genesisHash: hash("a"), deploymentBlock: "8" },
  services: { databaseUrl: "postgresql://aqua@127.0.0.1:5432/aqua", apiUrl: "http://localhost:3000", facilitatorUrl: "http://127.0.0.1:4022", brokerSocket: "/tmp/aqua.sock" },
  auth: { issuer: "http://localhost:3000", resource: "http://localhost:3000", rpId: "localhost", origin: "http://localhost:3000", pasetoPublicKeys: ["k4.public.0QPCsCVAycJZIZ13J36BogFriPmY0KXmGf99Jb_Qr3k"] },
  contracts: { aqua: contract("1"), aquaSwapRouter: contract("2"), limitSwapRouter: contract("3"), wrappedNativeToken: contract("4"), intentController: contract("5"), orderVaultFactory: contract("6"), boundedMatcher: contract("7"), permit2: contract("8"), x402ExactPermit2Proxy: contract("9") },
  fixtures: { tokens: [{ ...contract("a"), symbol: "BASE", decimals: 18 }, { ...contract("b"), symbol: "QUOTE", decimals: 6 }], pairs: [{ baseToken: address("a"), quoteToken: address("b") }] },
  indexer: { contracts: [address("1"), address("2"), address("5")], startBlock: "8", confirmations: 1 },
  keeper: { allowedTargets: [address("6")], allowedSelectors: ["0x12345678"] },
  secrets: { agent: "broker://agent", facilitator: "broker://facilitator", keeper: "broker://keeper", paseto: "broker://paseto" },
});

describe("runtime manifest", () => {
  test("round-trips with a verified content hash", () => {
    const withHash = { ...manifest, manifestHash: runtimeManifestHash(manifest) };
    expect(parseRuntimeManifest(JSON.stringify(withHash))).toEqual(withHash);
  });

  test("rejects stale content", () => {
    expect(() => parseRuntimeManifest(JSON.stringify({ ...manifest, manifestHash: hash("f") }))).toThrow("hash mismatch");
  });

  test("accepts sepolia on chain 11155111 and rejects the Anvil id", () => {
    const sepolia = runtimeManifestSchema.parse({ ...manifest, profile: "sepolia", chain: { ...manifest.chain, id: 11_155_111 } });
    expect(sepolia.profile).toBe("sepolia");
    expect(() => runtimeManifestSchema.parse({ ...manifest, profile: "sepolia" })).toThrow("11155111");
  });
});
