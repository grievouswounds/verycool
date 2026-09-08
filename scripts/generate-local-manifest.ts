import { randomUUID } from "node:crypto";
import { addressSchema, hashSchema, runtimeManifestHash, runtimeManifestSchema } from "@aqua/core";
import type { Hash, RuntimeManifest } from "@aqua/core";
import { initializeCubane, JsonRpcClient, keccakHex, hexToBytes } from "@aqua/evm";
import { z } from "zod";

const argument = (name: string): string => {
  const index = Bun.argv.indexOf(name);
  const value = index < 0 ? undefined : Bun.argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
};

const receiptNameSchema = z.enum([
  "aqua", "aquaSwapRouter", "limitSwapRouter", "wrappedNativeToken", "intentController",
  "orderVaultFactory", "permit2", "x402ExactPermit2Proxy",
]);
const inputSchema = z.object({
  transactions: z.object({
    aqua: hashSchema, aquaSwapRouter: hashSchema, limitSwapRouter: hashSchema,
    wrappedNativeToken: hashSchema, intentController: hashSchema, orderVaultFactory: hashSchema,
    permit2: hashSchema, x402ExactPermit2Proxy: hashSchema,
  }).strict(),
  tokenTransactions: z.array(hashSchema).min(2),
  pasetoPublicKeys: z.array(z.string().regex(/^k4\.public\.[A-Za-z0-9_-]{43}$/u)).min(1),
  brokerSocket: z.string().min(1),
  databaseUrl: z.url(),
  apiPort: z.number().int().min(1).max(65_535),
  facilitatorPort: z.number().int().min(1).max(65_535),
}).strict();

const receiptSchema = z.object({
  transactionHash: hashSchema, blockNumber: z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/u),
  contractAddress: addressSchema, status: z.literal("0x1"),
}).loose();
const blockSchema = z.object({ hash: hashSchema }).loose();
const responseSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.unknown() }).strict();

const rpcUrl = new URL(argument("--rpc-url"));
let rpcId = 0;
const request = async (method: string, params: readonly unknown[]): Promise<unknown> => {
  const id = ++rpcId;
  const response = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`RPC ${method} returned ${String(response.status)}`);
  const parsed = responseSchema.parse(await response.json());
  if (parsed.id !== id) throw new Error(`RPC ${method} response id mismatch`);
  return parsed.result;
};

const input = inputSchema.parse(await Bun.file(argument("--deployments")).json());
initializeCubane();
const rpc = new JsonRpcClient(rpcUrl, 10_000);
const chainId = await rpc.chainId();
if (chainId !== 31_337) throw new Error(`Expected Anvil chain 31337, received ${String(chainId)}`);
const genesis = blockSchema.parse(await request("eth_getBlockByNumber", ["0x0", false]));

const verifiedContract = async (transactionHash: Hash) => {
  const receipt = receiptSchema.parse(await request("eth_getTransactionReceipt", [transactionHash]));
  if (receipt.transactionHash !== transactionHash) throw new Error("Receipt transaction hash mismatch");
  const code = await rpc.getCode(receipt.contractAddress);
  if (code === "0x") throw new Error(`No runtime code at ${receipt.contractAddress}`);
  return {
    address: receipt.contractAddress,
    runtimeCodeHash: keccakHex(hexToBytes(code)),
    blockNumber: BigInt(receipt.blockNumber),
  };
};

const contracts = await Promise.all(Object.entries(input.transactions).map(async ([name, transactionHash]) => {
  const verified = await verifiedContract(transactionHash);
  return [receiptNameSchema.parse(name), verified] as const;
}));
const contractMap = Object.fromEntries(contracts);
const contract = (name: z.infer<typeof receiptNameSchema>) => {
  const value = contractMap[name];
  if (value === undefined) throw new Error(`Missing verified ${name} deployment`);
  return value;
};
const tokens = await Promise.all(input.tokenTransactions.map(async (transactionHash) => {
  const verified = await verifiedContract(transactionHash);
  const [decimals, symbol] = await Promise.all([rpc.tokenDecimals(verified.address), rpc.tokenSymbol(verified.address)]);
  if (symbol === null) throw new Error(`Fixture token ${verified.address} has no valid symbol`);
  return { address: verified.address, runtimeCodeHash: verified.runtimeCodeHash, decimals, symbol, blockNumber: verified.blockNumber };
}));
const firstToken = tokens[0];
const secondToken = tokens[1];
if (firstToken === undefined || secondToken === undefined) throw new Error("Two fixture tokens are required");
const deploymentBlock = [...contracts.map(([, value]) => value.blockNumber), ...tokens.map((token) => token.blockNumber)]
  .reduce((maximum, block) => block > maximum ? block : maximum, 0n);
const apiUrl = `http://localhost:${String(input.apiPort)}`;
const base = {
  schemaVersion: 1 as const, profile: "local-anvil" as const, runId: randomUUID(), createdAt: new Date().toISOString(),
  chain: { id: chainId, rpcUrl: rpcUrl.toString(), genesisHash: genesis.hash, deploymentBlock: deploymentBlock.toString(10) },
  services: { databaseUrl: input.databaseUrl, apiUrl, mcpUrl: `${apiUrl}/mcp`, facilitatorUrl: `http://127.0.0.1:${String(input.facilitatorPort)}`, brokerSocket: input.brokerSocket },
  auth: { issuer: apiUrl, resource: `${apiUrl}/mcp`, rpId: "localhost", origin: apiUrl, pasetoPublicKeys: input.pasetoPublicKeys },
  contracts: {
    aqua: contract("aqua"), aquaSwapRouter: contract("aquaSwapRouter"),
    limitSwapRouter: contract("limitSwapRouter"), wrappedNativeToken: contract("wrappedNativeToken"),
    intentController: contract("intentController"), orderVaultFactory: contract("orderVaultFactory"),
    permit2: contract("permit2"), x402ExactPermit2Proxy: contract("x402ExactPermit2Proxy"),
  },
  fixtures: { tokens: tokens.map((token) => ({address:token.address,runtimeCodeHash:token.runtimeCodeHash,decimals:token.decimals,symbol:token.symbol})), pairs: [{ baseToken: firstToken.address, quoteToken: secondToken.address }] },
  indexer: { contracts: [contract("aqua").address, contract("aquaSwapRouter").address, contract("intentController").address], startBlock: deploymentBlock.toString(10), confirmations: 1 },
  keeper: { allowedTargets: [contract("orderVaultFactory").address, contract("intentController").address], allowedSelectors: ["0xb1b0923a", "0x5f330b0f"] },
  secrets: { agent: "broker://agent", facilitator: "broker://facilitator", keeper: "broker://keeper", paseto: "broker://paseto" },
};
const parsed = runtimeManifestSchema.parse(base);
const manifest: RuntimeManifest = runtimeManifestSchema.parse({ ...parsed, manifestHash: runtimeManifestHash(parsed) });
await Bun.write(argument("--out"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ manifest: argument("--out"), hash: manifest.manifestHash, runId: manifest.runId }));
