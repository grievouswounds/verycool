import { describe, expect, test } from "bun:test";
import { ANVIL_ACCOUNT_ZERO_KEY, GATEWAY_NAME, HOSTED_VERCEL_CONFIG, parseVercelDeploymentUrl, rewriteManifestPublicOrigin } from "./deploy-bazantic-gateway.ts";
import { runtimeManifestSchema } from "@aqua/core";
import { signingKeyAddress } from "@aqua/evm";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const contract = (digit: string) => ({ address: address(digit), runtimeCodeHash: hash(digit) });

describe("Bazantic gateway deploy helpers", () => {
  test("extracts the Vercel production origin from CLI output", () => {
    const log = [
      "Inspect: https://vercel.com/acme/aqua/A1B2",
      "Production: https://aqua-hosted-xyz.vercel.app [2s]",
    ].join("\n");
    expect(parseVercelDeploymentUrl(log)).toBe("https://aqua-hosted-xyz.vercel.app");
    expect(parseVercelDeploymentUrl("no url here")).toBeUndefined();
  });

  test("prefers the public production alias over a SSO-protected deployment URL", () => {
    const log = [
      "Production      https://vercel-k3kwscp8e-solvasolva.vercel.app",
      "▲ Aliased         https://vercel-henna-gamma-46.vercel.app",
    ].join("\n");
    expect(parseVercelDeploymentUrl(log)).toBe("https://vercel-henna-gamma-46.vercel.app");
  });

  test("deploys the hosted API with the Bun framework preset instead of a static public directory", () => {
    expect(HOSTED_VERCEL_CONFIG.framework).toBe("bun");
    expect(HOSTED_VERCEL_CONFIG.bunVersion).toBe("1.x");
  });

  test("pins the Anvil account-zero key to the well-known address", () => {
    expect(GATEWAY_NAME).toBe("Aqua transaction preparation API");
    expect(signingKeyAddress(ANVIL_ACCOUNT_ZERO_KEY).toLowerCase()).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });

  test("rewrites manifest auth and service URLs to the Vercel origin", () => {
    const manifest = runtimeManifestSchema.parse({
      schemaVersion: 1, profile: "production", runId: "7b4df39d-33e8-41d2-9206-c8786f290dab",
      createdAt: "2026-09-07T10:00:00.000Z",
      chain: { id: 11155111, rpcUrl: "https://rpc.sepolia.org", genesisHash: hash("a"), deploymentBlock: "8" },
      services: { databaseUrl: "postgresql://aqua@127.0.0.1:5432/aqua", apiUrl: "https://localhost", facilitatorUrl: "https://localhost/facilitator", brokerSocket: "env://signer" },
      auth: { issuer: "https://localhost", resource: "https://localhost", rpId: "localhost", origin: "https://localhost", pasetoPublicKeys: ["k4.public.0QPCsCVAycJZIZ13J36BogFriPmY0KXmGf99Jb_Qr3k"] },
      contracts: { aqua: contract("1"), aquaSwapRouter: contract("2"), limitSwapRouter: contract("3"), wrappedNativeToken: contract("4"), intentController: contract("5"), orderVaultFactory: contract("6"), boundedMatcher: contract("7"), permit2: contract("8"), x402ExactPermit2Proxy: contract("9") },
      fixtures: { tokens: [{ ...contract("a"), symbol: "BASE", decimals: 18 }, { ...contract("b"), symbol: "QUOTE", decimals: 6 }], pairs: [{ baseToken: address("a"), quoteToken: address("b") }] },
      indexer: { contracts: [address("1")], startBlock: "8", confirmations: 1 },
      keeper: { allowedTargets: [address("5")], allowedSelectors: ["0x12345678"] },
      secrets: { agent: "broker://agent", facilitator: "broker://facilitator", keeper: "broker://keeper", paseto: "broker://paseto" },
    });
    const rewritten = rewriteManifestPublicOrigin(manifest, "https://aqua-hosted-xyz.vercel.app");
    expect(rewritten.services.apiUrl).toBe("https://aqua-hosted-xyz.vercel.app");
    expect(rewritten.services.facilitatorUrl).toBe("https://aqua-hosted-xyz.vercel.app/facilitator");
    expect(rewritten.auth.rpId).toBe("aqua-hosted-xyz.vercel.app");
    expect(rewritten.manifestHash).toBeDefined();
  });
});
