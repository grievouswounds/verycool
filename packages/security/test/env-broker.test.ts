import { describe, expect, test } from "bun:test";
import { hexSchema, runtimeManifestSchema, addressSchema } from "@aqua/core";
import { generateKeys } from "paseto-ts/v4";
import { EnvKeySecretBroker } from "../src/env-broker.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const contract = (digit: string) => ({ address: address(digit), runtimeCodeHash: hash(digit) });
const key = hexSchema.parse(`0x${"11".repeat(32)}`);

describe("EnvKeySecretBroker", () => {
  test("issues a PASETO whose subject is the granted address", async () => {
    const pair = generateKeys("public");
    const previous = {
      signer: Bun.env["AQUA_SIGNER"],
      agent: Bun.env["AQUA_AGENT_KEY"],
      facilitator: Bun.env["AQUA_FACILITATOR_KEY"],
      keeper: Bun.env["AQUA_KEEPER_KEY"],
      paseto: Bun.env["PASETO_V4_SECRET_KEY"],
    };
    Bun.env["AQUA_AGENT_KEY"] = key;
    Bun.env["AQUA_FACILITATOR_KEY"] = key;
    Bun.env["AQUA_KEEPER_KEY"] = key;
    Bun.env["PASETO_V4_SECRET_KEY"] = pair.secretKey;
    const publicKey = pair.publicKey;
    const manifest = runtimeManifestSchema.parse({
      schemaVersion: 1, profile: "production", runId: "7b4df39d-33e8-41d2-9206-c8786f290dab",
      createdAt: "2026-09-07T10:00:00.000Z",
      chain: { id: 11155111, rpcUrl: "https://rpc.sepolia.org", genesisHash: hash("a"), deploymentBlock: "8" },
      services: { databaseUrl: "postgresql://aqua@127.0.0.1:5432/aqua", apiUrl: "https://example.vercel.app", facilitatorUrl: "https://example.vercel.app/facilitator", brokerSocket: "env://signer" },
      auth: { issuer: "https://example.vercel.app", resource: "https://example.vercel.app", rpId: "example.vercel.app", origin: "https://example.vercel.app", pasetoPublicKeys: [publicKey] },
      contracts: { aqua: contract("1"), aquaSwapRouter: contract("2"), limitSwapRouter: contract("3"), wrappedNativeToken: contract("4"), intentController: contract("5"), orderVaultFactory: contract("6"), boundedMatcher: contract("7"), permit2: contract("8"), x402ExactPermit2Proxy: contract("9") },
      fixtures: { tokens: [{ ...contract("a"), symbol: "BASE", decimals: 18 }, { ...contract("b"), symbol: "QUOTE", decimals: 6 }], pairs: [{ baseToken: address("a"), quoteToken: address("b") }] },
      indexer: { contracts: [address("1")], startBlock: "8", confirmations: 1 },
      keeper: { allowedTargets: [address("5")], allowedSelectors: ["0x12345678"] },
      secrets: { agent: "broker://agent", facilitator: "broker://facilitator", keeper: "broker://keeper", paseto: "broker://paseto" },
    });
    try {
      const broker = new EnvKeySecretBroker(manifest);
      const identity = await broker.identity();
      expect(identity.pasetoPublicKey).toBe(publicKey);
      const token = await broker.issuePaseto({
        address: addressSchema.parse(address("c")), sessionId: "7b4df39d-33e8-41d2-9206-c8786f290dab",
        scopes: ["trading:read"], amr: ["siwe"], clientId: "test",
      });
      expect(token.startsWith("v4.public.")).toBe(true);
    } finally {
      Bun.env["AQUA_SIGNER"] = previous.signer ?? "";
      Bun.env["AQUA_AGENT_KEY"] = previous.agent ?? "";
      Bun.env["AQUA_FACILITATOR_KEY"] = previous.facilitator ?? "";
      Bun.env["AQUA_KEEPER_KEY"] = previous.keeper ?? "";
      Bun.env["PASETO_V4_SECRET_KEY"] = previous.paseto ?? "";
    }
  });
});
