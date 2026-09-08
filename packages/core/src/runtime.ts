import { createHash } from "node:crypto";
import { z } from "zod";
import { addressSchema, hashSchema } from "./schemas.ts";
import { parseStrictJson } from "./json.ts";

const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && url.hash === "";
}, "Expected an absolute fragment-free HTTP(S) URL");
const pasetoPublicKey = z.string().regex(/^k4\.public\.[A-Za-z0-9_-]{43}$/u);
const selectorSchema = z.string().regex(/^0x[0-9a-f]{8}$/u);
const keyReferenceSchema = z.string().regex(/^broker:\/\/[a-z][a-z0-9-]{0,63}$/u);

const contractSchema = z.object({ address: addressSchema, runtimeCodeHash: hashSchema }).strict();
const tokenSchema = contractSchema.extend({
  symbol: z.string().min(1).max(32), decimals: z.number().int().min(0).max(255),
}).strict();

export const runtimeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.enum(["local-anvil", "production"]),
  runId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  manifestHash: hashSchema.optional(),
  chain: z.object({
    id: z.number().int().positive(), rpcUrl: httpUrl, genesisHash: hashSchema,
    deploymentBlock: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  }).strict(),
  services: z.object({
    databaseUrl: z.url(), apiUrl: httpUrl, mcpUrl: httpUrl,
    facilitatorUrl: httpUrl, brokerSocket: z.string().min(1).max(1024),
  }).strict(),
  auth: z.object({
    issuer: httpUrl, resource: httpUrl, rpId: z.string().min(1), origin: httpUrl,
    pasetoPublicKeys: z.array(pasetoPublicKey).min(1),
  }).strict(),
  contracts: z.object({
    aqua: contractSchema, aquaSwapRouter: contractSchema, limitSwapRouter: contractSchema,
    wrappedNativeToken: contractSchema, intentController: contractSchema,
    orderVaultFactory: contractSchema, boundedMatcher: contractSchema,
    permit2: contractSchema, x402ExactPermit2Proxy: contractSchema,
  }).strict(),
  fixtures: z.object({
    tokens: z.array(tokenSchema).min(2),
    pairs: z.array(z.object({ baseToken: addressSchema, quoteToken: addressSchema }).strict()).min(1),
  }).strict(),
  indexer: z.object({
    contracts: z.array(addressSchema).min(1), startBlock: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    confirmations: z.number().int().min(0).max(10_000),
  }).strict(),
  keeper: z.object({
    allowedTargets: z.array(addressSchema).min(1), allowedSelectors: z.array(selectorSchema).min(1),
  }).strict(),
  secrets: z.object({
    agent: keyReferenceSchema, facilitator: keyReferenceSchema,
    keeper: keyReferenceSchema, paseto: keyReferenceSchema,
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const addresses = Object.values(manifest.contracts).map((contract) => contract.address);
  if (new Set(addresses).size !== addresses.length) {
    context.addIssue({ code: "custom", message: "Contract addresses must be unique", path: ["contracts"] });
  }
  const tokens = new Set(manifest.fixtures.tokens.map((token) => token.address));
  for (const [index, pair] of manifest.fixtures.pairs.entries()) {
    if (pair.baseToken === pair.quoteToken || !tokens.has(pair.baseToken) || !tokens.has(pair.quoteToken)) {
      context.addIssue({ code: "custom", message: "Pairs must reference two distinct fixture tokens", path: ["fixtures", "pairs", index] });
    }
  }
  if (manifest.profile === "local-anvil" && manifest.chain.id !== 31_337) {
    context.addIssue({ code: "custom", message: "local-anvil requires chain 31337", path: ["chain", "id"] });
  }
  if (new URL(manifest.auth.origin).hostname !== manifest.auth.rpId) {
    context.addIssue({ code: "custom", message: "WebAuthn origin hostname must equal RP ID", path: ["auth", "rpId"] });
  }
});

export type RuntimeManifest = z.infer<typeof runtimeManifestSchema>;

const canonicalManifest = (manifest: RuntimeManifest): string => {
  const copy: Record<string, unknown> = { ...manifest };
  delete copy["manifestHash"];
  return JSON.stringify(copy);
};

export const runtimeManifestHash = (manifest: RuntimeManifest) =>
  hashSchema.parse(`0x${createHash("sha256").update(canonicalManifest(manifest)).digest("hex")}`);

export const parseRuntimeManifest = (text: string): RuntimeManifest => {
  const manifest = runtimeManifestSchema.parse(parseStrictJson(text));
  if (manifest.manifestHash !== undefined && manifest.manifestHash !== runtimeManifestHash(manifest)) {
    throw new Error("Runtime manifest hash mismatch");
  }
  return manifest;
};

export const runtimeManifestPath = (arguments_: readonly string[]): string => {
  const index = arguments_.indexOf("--config");
  const path = index < 0 ? undefined : arguments_[index + 1];
  if (path === undefined || path.length === 0) throw new Error("Usage: --config <runtime-manifest.json>");
  return path;
};

export const loadRuntimeManifest = async (arguments_: readonly string[]): Promise<RuntimeManifest> =>
  parseRuntimeManifest(await Bun.file(runtimeManifestPath(arguments_)).text());

export const localProfileDefaults = Object.freeze({
  rpcTimeoutMs: 10_000,
  accessTtlSeconds: 600,
  refreshTtlSeconds: 28_800,
  intentAuthorizationTtlSeconds: 300,
  activityMaxSubscriptionsPerUser: 100,
  activityPollIntervalSeconds: 10,
  activityBlockChunkSize: 1_000,
  activityScanConcurrency: 4,
  activityWorkerLeaseSeconds: 120,
  orderbookBlockChunkSize: 500,
  orderbookPollIntervalSeconds: 2,
  keeperReplacementSeconds: 60,
  keeperLeaseSeconds: 30,
  triggerMinimumBlocks: 1,
  triggerMinimumSeconds: 1,
  keeperGasLimitCeiling: 1_000_000n,
  keeperMaxFeePerGasCeiling: 100_000_000_000n,
});
