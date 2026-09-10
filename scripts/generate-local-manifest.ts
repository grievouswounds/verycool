import { randomUUID } from "node:crypto";
import { addressSchema, hashSchema, hexSchema, runtimeManifestHash, runtimeManifestSchema } from "@aqua/core";
import type { RuntimeManifest } from "@aqua/core";
import { initializeCubane, JsonRpcClient, keccakHex, hexToBytes } from "@aqua/evm";
import { z } from "zod";

const argument = (name: string): string => {
  const index = Bun.argv.indexOf(name);
  const value = index < 0 ? undefined : Bun.argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
};
const optionalArgument = (name: string): string | undefined => {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Bun.argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
};
const profile = z.enum(["local-anvil", "sepolia"]).parse(optionalArgument("--profile") ?? "local-anvil");
const expectedChainId = profile === "local-anvil" ? 31_337 : 11_155_111;
const permit2DomainChainWord = profile === "local-anvil" ? "0x7a69" : "0xaa36a7";
const indexerConfirmations = profile === "local-anvil" ? 1 : 3;

const receiptNameSchema = z.enum([
  "aqua", "aquaSwapRouter", "limitSwapRouter", "wrappedNativeToken", "intentController",
  "orderVaultFactory", "boundedMatcher", "permit2", "x402ExactPermit2Proxy",
]);
const deploymentSchema = z.object({
  address: addressSchema,
  transactionHash: hashSchema.optional(),
  blockNumber: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  installation: z.enum(["create", "create2", "anvil-set-code"]),
}).strict();
const inputSchema = z.object({
  contracts: z.object({
    aqua: deploymentSchema, aquaSwapRouter: deploymentSchema, limitSwapRouter: deploymentSchema,
    wrappedNativeToken: deploymentSchema, intentController: deploymentSchema, orderVaultFactory: deploymentSchema,
    boundedMatcher: deploymentSchema, permit2: deploymentSchema, x402ExactPermit2Proxy: deploymentSchema,
  }).strict(),
  tokens: z.array(deploymentSchema).min(2),
  seedTransactions: z.array(hashSchema).min(10),
  seedOrders: z.array(z.object({ orderHash: hashSchema, transactionHash: hashSchema }).strict()).length(2),
  keeperAddress: addressSchema,
  pasetoPublicKeys: z.array(z.string().regex(/^k4\.public\.[A-Za-z0-9_-]{43}$/u)).min(1),
  brokerSocket: z.string().min(1),
  databaseUrl: z.url(),
  apiPort: z.number().int().min(1).max(65_535),
  facilitatorPort: z.number().int().min(1).max(65_535),
}).strict();

const receiptSchema = z.object({
  transactionHash: hashSchema, blockNumber: z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/u),
  contractAddress: addressSchema.nullable(), status: z.literal("0x1"),
}).loose();
const blockSchema = z.object({ hash: hashSchema }).loose();
const responseSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() }).strict();

const rpcUrl = new URL(argument("--rpc-url"));
let rpcId = 0;
const request = async (method: string, params: readonly unknown[]): Promise<unknown> => {
  const id = ++rpcId;
  const response = await fetch(rpcUrl, {
    method: "POST",     headers: { "content-type": "application/json", "user-agent": "aqua-probe/1" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`RPC ${method} returned ${String(response.status)}`);
  const parsed = responseSchema.parse(await response.json());
  if (parsed.id !== id) throw new Error(`RPC ${method} response id mismatch`);
  if (parsed.error !== undefined) throw new Error(`RPC ${method} failed: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
};
const selector = (signature: string): string => keccakHex(new TextEncoder().encode(signature)).slice(0, 10);
const ethCall = async (to: string, data: string): Promise<string> => z.string().regex(/^0x[0-9a-fA-F]*$/u)
  .parse(await request("eth_call", [{ to, data }, "latest"]));
const callAddress = async (to: string, signature: string): Promise<string> => {
  const output = await ethCall(to, selector(signature));
  if (output.length !== 66) throw new Error(`${signature} returned malformed address data`);
  return addressSchema.parse(`0x${output.slice(-40)}`);
};
const callUint = async (to: string, signature: string): Promise<bigint> => BigInt(await ethCall(to, selector(signature)));
const callAllowed = async (matcher: string, target: string, allowedSelector: string): Promise<boolean> => {
  const targetWord = target.slice(2).padStart(64, "0");
  const selectorWord = allowedSelector.slice(2).padEnd(64, "0");
  return BigInt(await ethCall(matcher, `${selector("allowed(address,bytes4)")}${targetWord}${selectorWord}`)) === 1n;
};

const input = inputSchema.parse(await Bun.file(argument("--deployments")).json());
initializeCubane();
const rpc = new JsonRpcClient(rpcUrl, 30_000);
const chainId = await rpc.chainId();
if (chainId !== expectedChainId) {
  throw new Error(`Expected chain ${String(expectedChainId)} for profile ${profile}, received ${String(chainId)}`);
}
const sepoliaGenesis = hashSchema.parse("0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9");
let genesis: z.infer<typeof blockSchema>;
try {
  genesis = blockSchema.parse(await request("eth_getBlockByNumber", ["0x0", false]));
} catch (error) {
  if (profile !== "sepolia") throw error;
  genesis = { hash: sepoliaGenesis };
}
for (const transactionHash of input.seedTransactions) {
  z.object({ transactionHash: hashSchema, status: z.literal("0x1") }).loose()
    .parse(await request("eth_getTransactionReceipt", [transactionHash]));
}
if (new Set(input.seedOrders.map(({ orderHash }) => orderHash)).size !== 2) throw new Error("Seed order hashes must be unique");

const verifiedContract = async (deployment: z.infer<typeof deploymentSchema>) => {
  if (deployment.transactionHash !== undefined) {
    const receipt = receiptSchema.parse(await request("eth_getTransactionReceipt", [deployment.transactionHash]));
    if (receipt.transactionHash !== deployment.transactionHash) throw new Error("Receipt transaction hash mismatch");
    if (BigInt(receipt.blockNumber) !== BigInt(deployment.blockNumber)) throw new Error("Deployment block mismatch");
    if (deployment.installation === "create" && receipt.contractAddress !== deployment.address) throw new Error("CREATE address mismatch");
  }
  const code = await rpc.getCode(deployment.address);
  if (code === "0x") throw new Error(`No runtime code at ${deployment.address}`);
  return {
    address: deployment.address,
    runtimeCodeHash: keccakHex(hexToBytes(code)),
    blockNumber: BigInt(deployment.blockNumber),
  };
};

const contracts = await Promise.all(Object.entries(input.contracts).map(async ([name, deployment]) => {
  const verified = await verifiedContract(deployment);
  return [receiptNameSchema.parse(name), verified] as const;
}));
const contractMap = Object.fromEntries(contracts);
const contract = (name: z.infer<typeof receiptNameSchema>) => {
  const value = contractMap[name];
  if (value === undefined) throw new Error(`Missing verified ${name} deployment`);
  return value;
};
// The manifest's own contract schema is address+runtimeCodeHash only (no blockNumber, which
// exists solely to compute deploymentBlock below), so entries placed into `contracts:` must be
// narrowed to those two fields or strict-schema validation rejects the extra property.
const contractFields = (name: z.infer<typeof receiptNameSchema>) => {
  const { address, runtimeCodeHash } = contract(name);
  return { address, runtimeCodeHash };
};
const callString = async (to: string, signature: string): Promise<string> => {
  const output = await ethCall(to, selector(signature));
  if (output.length < 130) throw new Error(`${signature} returned malformed string data`);
  const length = Number(BigInt(`0x${output.slice(66, 130)}`));
  return new TextDecoder().decode(hexToBytes(hexSchema.parse(`0x${output.slice(130, 130 + length * 2)}`)));
};
const tokens = await Promise.all(input.tokens.map(async (deployment) => {
  const verified = await verifiedContract(deployment);
  const [decimals, symbol] = await Promise.all([
    callUint(verified.address, "decimals()").then(Number),
    callString(verified.address, "symbol()"),
  ]);
  if (symbol.length === 0) throw new Error(`Fixture token ${verified.address} has no valid symbol`);
  return { address: verified.address, runtimeCodeHash: verified.runtimeCodeHash, decimals, symbol, blockNumber: verified.blockNumber };
}));
const firstToken = tokens[0];
const secondToken = tokens[1];
if (firstToken === undefined || secondToken === undefined) throw new Error("Two fixture tokens are required");
const canonicalPermit2 = addressSchema.parse("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const canonicalX402 = addressSchema.parse("0x402085c248eea27d92e8b30b2c58ed07f9e20001");
if (contract("permit2").address !== canonicalPermit2 || contract("x402ExactPermit2Proxy").address !== canonicalX402) {
  throw new Error("Permit2 and x402 exact proxy must use their canonical addresses");
}
for (const routerName of ["aquaSwapRouter", "limitSwapRouter"] as const) {
  const router = contract(routerName).address;
  if (await callAddress(router, "AQUA()") !== contract("aqua").address) throw new Error(`${routerName} has the wrong Aqua binding`);
  if (!await callAllowed(contract("boundedMatcher").address, router, "0xf4d2d412")) throw new Error(`Bounded matcher does not allow ${routerName}.swap`);
}
if (!await callAllowed(contract("boundedMatcher").address, contract("intentController").address, "0x5f330b0f")) {
  throw new Error("Bounded matcher does not allow intentController.activate");
}
if (!await callAllowed(contract("boundedMatcher").address, contract("orderVaultFactory").address, "0x95d5857e")) {
  throw new Error("Bounded matcher does not allow orderVaultFactory.execute");
}
const keeper = await callAddress(contract("intentController").address, "operator()");
if (keeper !== input.keeperAddress) throw new Error("Intent controller operator does not match the broker keeper");
if (await callAddress(contract("boundedMatcher").address, "operator()") !== keeper) throw new Error("Intent controller and bounded matcher operators differ");
if (await callAddress(canonicalX402, "PERMIT2()") !== canonicalPermit2) throw new Error("x402 exact proxy has the wrong Permit2 binding");
const typeHash = keccakHex(new TextEncoder().encode("EIP712Domain(string name,uint256 chainId,address verifyingContract)"));
const nameHash = keccakHex(new TextEncoder().encode("Permit2"));
const word = (value: string): string => value.replace(/^0x/u, "").padStart(64, "0");
const expectedPermit2Separator = keccakHex(hexToBytes(hexSchema.parse(`0x${word(typeHash)}${word(nameHash)}${word(permit2DomainChainWord)}${word(canonicalPermit2)}`)));
if ((await ethCall(canonicalPermit2, selector("DOMAIN_SEPARATOR()"))).toLowerCase() !== expectedPermit2Separator) {
  throw new Error(`Permit2 DOMAIN_SEPARATOR does not match canonical Permit2 on ${profile}`);
}
const expectedTokens = [
  { symbol: "aUSD", decimals: 6, supply: 1_000_000_000_000n },
  { symbol: "aETH", decimals: 18, supply: 1_000_000_000_000_000_000_000n },
] as const;
for (const [index, expected] of expectedTokens.entries()) {
  const token = tokens[index];
  if (token === undefined) throw new Error(`Missing fixture token ${String(index)}`);
  if (token.symbol !== expected.symbol || token.decimals !== expected.decimals
    || await callUint(token.address, "totalSupply()") !== expected.supply) throw new Error(`Fixture token ${String(index)} does not match expected metadata and supply`);
}
const deploymentBlock = [...contracts.map(([, value]) => value.blockNumber), ...tokens.map((token) => token.blockNumber)]
  .reduce((maximum, block) => block > maximum ? block : maximum, 0n);
const apiUrl = `http://localhost:${String(input.apiPort)}`;
const base = {
  schemaVersion: 1 as const, profile, runId: randomUUID(), createdAt: new Date().toISOString(),
  chain: { id: chainId, rpcUrl: rpcUrl.toString(), genesisHash: genesis.hash, deploymentBlock: deploymentBlock.toString(10) },
  services: { databaseUrl: input.databaseUrl, apiUrl, facilitatorUrl: `http://127.0.0.1:${String(input.facilitatorPort)}`, brokerSocket: input.brokerSocket },
  auth: { issuer: apiUrl, resource: apiUrl, rpId: "localhost", origin: apiUrl, pasetoPublicKeys: input.pasetoPublicKeys },
  contracts: {
    aqua: contractFields("aqua"), aquaSwapRouter: contractFields("aquaSwapRouter"),
    limitSwapRouter: contractFields("limitSwapRouter"), wrappedNativeToken: contractFields("wrappedNativeToken"),
    intentController: contractFields("intentController"), orderVaultFactory: contractFields("orderVaultFactory"),
    boundedMatcher: contractFields("boundedMatcher"), permit2: contractFields("permit2"),
    x402ExactPermit2Proxy: contractFields("x402ExactPermit2Proxy"),
  },
  fixtures: { tokens: tokens.map((token) => ({address:token.address,runtimeCodeHash:token.runtimeCodeHash,decimals:token.decimals,symbol:token.symbol})), pairs: [
    { baseToken: firstToken.address, quoteToken: secondToken.address },
    { baseToken: secondToken.address, quoteToken: firstToken.address },
  ] },
  indexer: { contracts: [contract("aqua").address, contract("aquaSwapRouter").address, contract("intentController").address], startBlock: deploymentBlock.toString(10), confirmations: indexerConfirmations },
  keeper: {
    allowedTargets: [contract("intentController").address, contract("orderVaultFactory").address, contract("boundedMatcher").address],
    allowedSelectors: ["0xb1b0923a", "0x5f330b0f", "0x95d5857e", "0xc8d18a45", "0xeeabec06", "0xf15d634f"],
  },
  secrets: { agent: "broker://agent", facilitator: "broker://facilitator", keeper: "broker://keeper", paseto: "broker://paseto" },
};
const parsed = runtimeManifestSchema.parse(base);
const manifest: RuntimeManifest = runtimeManifestSchema.parse({ ...parsed, manifestHash: runtimeManifestHash(parsed) });
await Bun.write(argument("--out"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ manifest: argument("--out"), hash: manifest.manifestHash, runId: manifest.runId }));
