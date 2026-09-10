import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { addressSchema, hashSchema, hexSchema, limitOrderRequestSchema, runtimeManifestHash, runtimeManifestSchema } from "@aqua/core";
import type { Address, Hash, Hex, RuntimeManifest } from "@aqua/core";
import { ProtocolService } from "@aqua/contracts";
import { ETHEREUM_SEPOLIA_CHAIN_ID, createPooledRpcClient, hexToBytes, initializeCubane, keccakHex, primaryRpcUrl, serveRpcProxy, signingKeyAddress } from "@aqua/evm";
import { z } from "zod";

const env = (name: string): string => {
  const value = Bun.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing required environment variable ${name}`);
  return value;
};
const log = (message: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ level: "info", component: "deploy-public-chain", message, ...extra }));
};

const optionalEnv = (name: string): string | undefined => {
  const value = Bun.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};
const addressFromEnv = (name: string, fallback: string) => addressSchema.parse(optionalEnv(name) ?? fallback);

initializeCubane();
const aquaRoot = optionalEnv("AQUA_ROOT") ?? process.cwd();
const stateDir = optionalEnv("AQUA_STATE_DIR") ?? `${process.cwd()}/.data`;
const buildDir = `${stateDir}/chain-build`;
const deploymentsPath = `${stateDir}/deployments.production.json`;
const addressesPath = `${stateDir}/deployment-addresses.production.json`;
const manifestPath = `${stateDir}/runtime-manifest.production.json`;
const partialPath = `${stateDir}/deployments.partial.json`;
const PUBLIC_CHAIN_ID = ETHEREUM_SEPOLIA_CHAIN_ID;
const ANVIL_ACCOUNT_ZERO_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const agentKey = hexSchema.parse(env("AQUA_AGENT_KEY"));
const facilitatorKey = hexSchema.parse(env("AQUA_FACILITATOR_KEY"));
const keeperKey = hexSchema.parse(env("AQUA_KEEPER_KEY"));
const pasetoSecret = env("PASETO_V4_SECRET_KEY");
const encodedPaseto = pasetoSecret.slice("k4.secret.".length);
const pasetoSecretBytes = Buffer.from(encodedPaseto, "base64url");
if (!/^k4\.secret\.[A-Za-z0-9_-]{86}$/u.test(pasetoSecret) || pasetoSecretBytes.length !== 64) throw new Error("Broker PASETO key is invalid");
const pasetoPublicKey = `k4.public.${Buffer.from(pasetoSecretBytes.subarray(32)).toString("base64url")}`;
const identity = {
  agent: signingKeyAddress(agentKey), facilitator: signingKeyAddress(facilitatorKey),
  keeper: signingKeyAddress(keeperKey), pasetoPublicKey,
};
const fixtureMakerRaw = optionalEnv("AQUA_FIXTURE_MAKER_KEY");
const FIXTURE_MAKER_KEY = hexSchema.parse(fixtureMakerRaw ?? agentKey);
const FIXTURE_MAKER = signingKeyAddress(FIXTURE_MAKER_KEY);
const secrets = new Set<string>([agentKey, facilitatorKey, keeperKey, FIXTURE_MAKER_KEY]);
const deployerKey = (): Hex => {
  const key = hexSchema.parse(env("AQUA_DEPLOYER_PRIVATE_KEY"));
  if (key.toLowerCase() === ANVIL_ACCOUNT_ZERO_KEY) throw new Error("Refusing the public Anvil account-0 key on Ethereum Sepolia");
  secrets.add(key);
  return key;
};
const deployerAddress = (): Address => signingKeyAddress(deployerKey());
const upstreamSources = (): { aqua: string; swapvm: string; x402: string; permit2: string } => ({
  aqua: env("AQUA_UPSTREAM"), swapvm: env("SWAPVM_UPSTREAM"),
  x402: env("X402_UPSTREAM"), permit2: env("PERMIT2_UPSTREAM"),
});
const PINNED_AQUA = addressFromEnv("AQUA_CONTRACT_AQUA", "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a");
const PINNED_AQUA_SWAP_ROUTER = addressFromEnv("AQUA_CONTRACT_AQUA_SWAP_ROUTER", "0x07b3475bbdb0389c21640b1334eff6a41970136b");
const PINNED_LIMIT_SWAP_ROUTER = addressFromEnv("AQUA_CONTRACT_LIMIT_SWAP_ROUTER", "0xed9275955c0085a322c3b26735beb25cc21171f9");
const PINNED_INTENT_CONTROLLER = addressFromEnv("AQUA_CONTRACT_INTENT_CONTROLLER", "0xbae91f21b2bf19013af494b107d9e0f8731c707a");
const PINNED_ORDER_VAULT_FACTORY = addressFromEnv("AQUA_CONTRACT_ORDER_VAULT_FACTORY", "0x90da9256755b496609dc0162a8cef413f8742d09");
const PINNED_BOUNDED_MATCHER = addressFromEnv("AQUA_CONTRACT_BOUNDED_MATCHER", "0x1062b3da82e21b55be9d7658ed2557b9021ddc52");
const PINNED_TOKEN_A = addressFromEnv("AQUA_CONTRACT_TOKEN_A", "0x019799b067422517212ce754f96d4faa6cc6a090");
const PINNED_TOKEN_B = addressFromEnv("AQUA_CONTRACT_TOKEN_B", "0x0bb3844e65962a303bc4cabdd4b742a324f2f570");
const SEPOLIA_WETH = addressFromEnv("AQUA_CONTRACT_WETH", "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14");
const PERMIT2_ADDRESS = addressSchema.parse("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const X402_EXACT_PROXY_ADDRESS = addressSchema.parse("0x402085c248eea27d92e8b30b2c58ed07f9e20001");
const CREATE2_DEPLOYER = addressSchema.parse("0x4e59b44847b379578588920cA78FbF26c0B4956C");
const X402_EXACT_SALT = "0x0000000000000000000000000000000000000000000000003000000007263b0e";
const SWAP_SELECTOR = "0xf4d2d412";
const ACTIVATE_SELECTOR = "0x5f330b0f";
const OBSERVE_SELECTOR = "0xb1b0923a";
const FACTORY_EXECUTE_SELECTOR = "0x95d5857e";
const MIN_FUNDED_WEI = 10n ** 16n;
const GAS_PRICE_FLOOR_WEI = 2_000_000_000n;
const word = (value: string): string => value.replace(/^0x/u, "").padStart(64, "0");
const permit2DomainSeparator = (chainId: bigint): string => {
  const typeHash = keccakHex(new TextEncoder().encode("EIP712Domain(string name,uint256 chainId,address verifyingContract)"));
  const nameHash = keccakHex(new TextEncoder().encode("Permit2"));
  return keccakHex(hexToBytes(hexSchema.parse(`0x${word(typeHash)}${word(nameHash)}${word(`0x${chainId.toString(16)}`)}${word(PERMIT2_ADDRESS)}`)));
};

await mkdir(stateDir, { recursive: true });
await Bun.write(`${stateDir}/identity.production.json`, `${JSON.stringify(identity, null, 2)}\n`);
const primary = primaryRpcUrl(PUBLIC_CHAIN_ID, "http://127.0.0.1:0");
const rpc = createPooledRpcClient({ id: PUBLIC_CHAIN_ID, rpcUrl: primary }, 30_000);
const proxy = serveRpcProxy(rpc);
const rpcUrl = proxy.url;
const legacyBroadcast = ["--legacy"] as const;
let gasPriceWei = GAS_PRICE_FLOOR_WEI;

const run = async (command: readonly string[], cwd: string): Promise<string> => {
  const proc = Bun.spawn([...command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (exitCode !== 0) {
    const rendered = command.map((part) => secrets.has(part) ? "<redacted>" : part).join(" ");
    throw new Error(`${rendered} (in ${cwd}) failed:\n${(stderr || stdout).trim().slice(-2_000)}`);
  }
  return stdout;
};

const prepareCopy = async (source: string, dest: string): Promise<void> => {
  await mkdir(buildDir, { recursive: true });
  await run(["rm", "-rf", dest], buildDir);
  await run(["cp", "-r", source, dest], buildDir);
  await run(["chmod", "-R", "u+w", dest], buildDir);
};

type Installation = "create" | "create2" | "preexisting";
interface Deployed {
  readonly address: Address;
  readonly transactionHash?: Hash | undefined;
  readonly blockNumber: string;
  readonly installation: Installation;
}
const deploymentSchema = z.object({
  address: addressSchema, transactionHash: hashSchema.optional(),
  blockNumber: z.string().regex(/^(?:0|[1-9][0-9]*)$/u), installation: z.enum(["create", "create2", "preexisting"]),
}).strict();
const contractsSchema = z.object({
  aqua: deploymentSchema, aquaSwapRouter: deploymentSchema, limitSwapRouter: deploymentSchema,
  wrappedNativeToken: deploymentSchema, intentController: deploymentSchema, orderVaultFactory: deploymentSchema,
  boundedMatcher: deploymentSchema, permit2: deploymentSchema, x402ExactPermit2Proxy: deploymentSchema,
}).strict();
const contractNames = [
  "aqua", "aquaSwapRouter", "limitSwapRouter", "wrappedNativeToken", "intentController",
  "orderVaultFactory", "boundedMatcher", "permit2", "x402ExactPermit2Proxy",
] as const;
const evidenceSchema = z.object({
  contracts: contractsSchema, tokens: z.array(deploymentSchema).length(2),
  seedTransactions: z.array(hashSchema).min(0),
  seedOrders: z.array(z.object({ orderHash: hashSchema, transactionHash: hashSchema }).strict()).min(0),
}).loose();

const receiptBlock = async (transactionHash: string): Promise<string> => {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await rpc.transactionReceipt(hashSchema.parse(transactionHash));
    if (receipt !== null) {
      if (receipt.status !== "success") throw new Error(`Missing successful receipt for ${transactionHash}`);
      return receipt.blockNumber.toString(10);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Timed out waiting for receipt ${transactionHash}`);
};
const currentBlock = async (): Promise<string> => (await rpc.blockNumber()).toString(10);
const nativeBalance = async (address: string): Promise<bigint> => rpc.balance(addressSchema.parse(address));
const requireFunded = async (address: string, label: string): Promise<void> => {
  const balance = await nativeBalance(address);
  if (balance < MIN_FUNDED_WEI) throw new Error(`${label} ${address} needs Ethereum Sepolia ETH (have ${balance.toString(10)} wei)`);
};
const hasCode = async (address: string): Promise<boolean> => (await rpc.getCode(addressSchema.parse(address))) !== "0x";
const existingAt = async (address: string, installation: Installation = "preexisting"): Promise<Deployed> => {
  if (!await hasCode(address)) throw new Error(`Expected runtime code at ${address}`);
  return { address: addressSchema.parse(address), blockNumber: await currentBlock(), installation };
};
const partialSchema = z.record(z.string(), deploymentSchema);
const partial = existsSync(partialPath) ? partialSchema.parse(await Bun.file(partialPath).json()) : {};
const savePartial = async (name: string, deployed: Deployed): Promise<Deployed> => {
  partial[name] = deployed;
  await Bun.write(partialPath, `${JSON.stringify(partial, null, 2)}\n`);
  return deployed;
};
const reuseOrCreate = async (name: string, create: () => Promise<Deployed>): Promise<Deployed> => {
  const recorded = partial[name];
  if (recorded !== undefined && await hasCode(recorded.address)) {
    log(`reusing ${name} from partial public-chain deployment`, recorded);
    return recorded;
  }
  return savePartial(name, await create());
};

const forgeCreate = async (options: {
  readonly cwd: string; readonly contractPath: string; readonly contractName: string; readonly constructorArgs?: readonly string[];
}): Promise<Deployed> => {
  const args = [
    "forge", "create", `${options.contractPath}:${options.contractName}`,
    "--rpc-url", rpcUrl, "--private-key", deployerKey(), "--broadcast",
    ...legacyBroadcast, "--gas-limit", "5000000", "--gas-price", gasPriceWei.toString(10),
  ];
  if (options.constructorArgs !== undefined && options.constructorArgs.length > 0) args.push("--constructor-args", ...options.constructorArgs);
  const stdout = await run(args, options.cwd);
  const address = addressSchema.parse(/Deployed to: (0x[0-9a-fA-F]{40})/u.exec(stdout)?.[1]);
  const transactionHash = hashSchema.parse(/Transaction hash: (0x[0-9a-fA-F]{64})/u.exec(stdout)?.[1]);
  const deployed = { address, transactionHash, blockNumber: await receiptBlock(transactionHash), installation: "create" as const };
  log(`deployed ${options.contractName}`, deployed);
  return deployed;
};

const nextNonce = async (from: Address): Promise<string> => (await rpc.transactionCount(from)).toString(10);

const publishSigned = async (raw: string): Promise<Hash> => {
  const signed = hexSchema.parse(raw.trim().split(/\s+/u).at(-1));
  const transactionHash = await rpc.sendRawTransaction(signed);
  await receiptBlock(transactionHash);
  return transactionHash;
};

const castSend = async (to: string, signatureOrData: string, args: readonly string[] = [], privateKey?: Hex, gasLimit = "3000000"): Promise<Hash> => {
  const key = privateKey ?? deployerKey();
  const from = signingKeyAddress(key);
  const raw = await run([
    "cast", "mktx", to, signatureOrData, ...args,
    "--private-key", key, "--legacy", "--gas-limit", gasLimit, "--gas-price", gasPriceWei.toString(10),
    "--nonce", await nextNonce(from), "--chain", String(PUBLIC_CHAIN_ID),
  ], aquaRoot);
  return publishSigned(raw);
};
const castSendValue = async (to: string, wei: string): Promise<Hash> => {
  const raw = await run([
    "cast", "mktx", to,     "--value", wei, "--private-key", deployerKey(), "--legacy",
    "--gas-limit", "21000", "--gas-price", gasPriceWei.toString(10), "--nonce", await nextNonce(deployerAddress()),
    "--chain", String(PUBLIC_CHAIN_ID),
  ], aquaRoot);
  return publishSigned(raw);
};

const castCall = async (to: string, signature: string, args: readonly string[] = []): Promise<string> =>
  (await run(["cast", "call", to, signature, ...args, "--rpc-url", rpcUrl], aquaRoot)).trim();
const sameAddress = (actual: string, expected: string): boolean => actual.toLowerCase() === expected.toLowerCase();
const assertDeploymentBindings = async (
  contracts: z.infer<typeof contractsSchema>,
  tokens: readonly Deployed[],
  options: { readonly requireFixtureSupply?: boolean } = {},
): Promise<void> => {
  for (const router of [contracts.aquaSwapRouter.address, contracts.limitSwapRouter.address]) {
    if (!sameAddress(await castCall(router, "AQUA()(address)"), contracts.aqua.address)) throw new Error(`Router ${router} has the wrong Aqua binding`);
  }
  const onChainControllerOperator = await castCall(contracts.intentController.address, "operator()(address)");
  if (!sameAddress(onChainControllerOperator, identity.keeper)) {
    throw new Error(`Intent controller operator ${onChainControllerOperator} does not match AQUA_KEEPER_KEY address ${identity.keeper}. Operator is immutable: put the private key for ${onChainControllerOperator} in AQUA_KEEPER_KEY (bun run identities).`);
  }
  if (!sameAddress(await castCall(contracts.intentController.address, "matcher()(address)"), contracts.boundedMatcher.address)) throw new Error("Intent controller matcher is not bound to the bounded matcher");
  const onChainMatcherOperator = await castCall(contracts.boundedMatcher.address, "operator()(address)");
  if (!sameAddress(onChainMatcherOperator, identity.keeper)) {
    throw new Error(`Bounded matcher operator ${onChainMatcherOperator} does not match AQUA_KEEPER_KEY address ${identity.keeper}. Operator is immutable: put the private key for ${onChainMatcherOperator} in AQUA_KEEPER_KEY.`);
  }
  for (const router of [contracts.aquaSwapRouter.address, contracts.limitSwapRouter.address]) {
    if (await castCall(contracts.boundedMatcher.address, "allowed(address,bytes4)(bool)", [router, SWAP_SELECTOR]) !== "true") throw new Error(`Bounded matcher does not allow swap on ${router}`);
  }
  if (await castCall(contracts.boundedMatcher.address, "allowed(address,bytes4)(bool)", [contracts.intentController.address, ACTIVATE_SELECTOR]) !== "true") throw new Error("Bounded matcher does not allow intent activate");
  if (await castCall(contracts.boundedMatcher.address, "allowed(address,bytes4)(bool)", [contracts.intentController.address, OBSERVE_SELECTOR]) !== "true") throw new Error("Bounded matcher does not allow intent observe");
  if (await castCall(contracts.boundedMatcher.address, "allowed(address,bytes4)(bool)", [contracts.orderVaultFactory.address, FACTORY_EXECUTE_SELECTOR]) !== "true") throw new Error("Bounded matcher does not allow vault factory execute");
  if (!sameAddress(await castCall(contracts.x402ExactPermit2Proxy.address, "PERMIT2()(address)"), PERMIT2_ADDRESS)) throw new Error("x402 exact proxy is not bound to canonical Permit2");
  const permit2Separator = hashSchema.parse((await castCall(contracts.permit2.address, "DOMAIN_SEPARATOR()(bytes32)")).trim().split(/\s+/u)[0] ?? "");
  if (permit2Separator !== permit2DomainSeparator(BigInt(PUBLIC_CHAIN_ID))) throw new Error("Permit2 DOMAIN_SEPARATOR does not match canonical Permit2 on Ethereum Sepolia");
  const expectedTokens = [
    { symbol: "aUSD", decimals: "6", supply: "1000000000000" },
    { symbol: "aETH", decimals: "18", supply: "1000000000000000000000" },
  ];
  for (const [index, expected] of expectedTokens.entries()) {
    const token = tokens[index];
    if (token === undefined) throw new Error("Both fixture tokens must be deployed");
    const [symbol, decimals, supply] = await Promise.all([
      castCall(token.address, "symbol()(string)"), castCall(token.address, "decimals()(uint8)"), castCall(token.address, "totalSupply()(uint256)"),
    ]);
    if (symbol.replace(/^"|"$/gu, "") !== expected.symbol || decimals !== expected.decimals) {
      throw new Error(`Fixture token ${token.address} metadata is invalid`);
    }
    if (options.requireFixtureSupply !== false && supply.split(" ")[0] !== expected.supply) {
      throw new Error(`Fixture token ${token.address} supply is invalid`);
    }
  }
};

const validateRecordedDeployment = async (): Promise<boolean> => {
  if (!existsSync(deploymentsPath) || !existsSync(addressesPath)) return false;
  try {
    const evidence = evidenceSchema.parse(await Bun.file(deploymentsPath).json());
    if (evidence.contracts.permit2.address !== PERMIT2_ADDRESS || evidence.contracts.x402ExactPermit2Proxy.address !== X402_EXACT_PROXY_ADDRESS) return false;
    const all = [...Object.values(evidence.contracts), ...evidence.tokens];
    if (!(await Promise.all(all.map(async ({ address }) => hasCode(address)))).every(Boolean)) return false;
    for (const transactionHash of evidence.seedTransactions) {
      const receipt = await rpc.transactionReceipt(transactionHash);
      if (receipt?.status !== "success") return false;
    }
    if (existsSync(manifestPath)) {
      const manifest = runtimeManifestSchema.parse(await Bun.file(manifestPath).json());
      if (manifest.profile !== "production" || manifest.chain.id !== PUBLIC_CHAIN_ID) return false;
      for (const name of contractNames) {
        const deployment = evidence.contracts[name];
        const recorded = manifest.contracts[name];
        const codeHash = keccakHex(hexToBytes(await rpc.getCode(addressSchema.parse(deployment.address))));
        if (recorded.address !== deployment.address || recorded.runtimeCodeHash !== codeHash) return false;
      }
      for (const [index, deployment] of evidence.tokens.entries()) {
        const recorded = manifest.fixtures.tokens[index];
        if (recorded?.address !== deployment.address) return false;
        if (recorded.runtimeCodeHash !== keccakHex(hexToBytes(await rpc.getCode(addressSchema.parse(deployment.address))))) return false;
      }
    }
    await assertDeploymentBindings(evidence.contracts, evidence.tokens);
    return true;
  } catch (error: unknown) {
    log("recorded public-chain deployment is incomplete or stale; redeploying", { reason: error instanceof Error ? error.message : String(error) });
    return false;
  }
};

const resolveGasPrice = async (): Promise<bigint> => {
  const override = Bun.env["AQUA_DEPLOY_GAS_PRICE_WEI"]?.trim();
  if (override !== undefined && override.length > 0) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(override)) throw new Error("AQUA_DEPLOY_GAS_PRICE_WEI must be a decimal wei integer");
    return BigInt(override);
  }
  const quoted = await rpc.gasPrice();
  return quoted < GAS_PRICE_FLOOR_WEI ? GAS_PRICE_FLOOR_WEI : quoted;
};

const writeManifest = async (verifiedContracts: z.infer<typeof contractsSchema>, tokenA: Deployed, tokenB: Deployed): Promise<void> => {
  const publicOrigin = (Bun.env["AQUA_PUBLIC_ORIGIN"] ?? Bun.env["AQUA_VERCEL_URL"] ?? "https://localhost").replace(/\/$/u, "");
  const originUrl = new URL(publicOrigin);
  const databaseUrl = env("DATABASE_URL");
  const genesis = await rpc.block(0n);
  const verifiedContract = async (deployment: Deployed) => {
    const code = await rpc.getCode(addressSchema.parse(deployment.address));
    if (code === "0x") throw new Error(`No runtime code at ${deployment.address}`);
    return { address: addressSchema.parse(deployment.address), runtimeCodeHash: keccakHex(hexToBytes(code)), blockNumber: BigInt(deployment.blockNumber) };
  };
  const contractEntries = await Promise.all(contractNames.map(async (name) => {
    const verified = await verifiedContract(verifiedContracts[name]);
    return [name, verified] as const;
  }));
  const tokens = await Promise.all([tokenA, tokenB].map(async (deployment) => {
    const verified = await verifiedContract(deployment);
    const [decimals, symbol] = await Promise.all([rpc.tokenDecimals(verified.address), rpc.tokenSymbol(verified.address)]);
    if (symbol === null) throw new Error(`Fixture token ${verified.address} has no valid symbol`);
    return { address: verified.address, runtimeCodeHash: verified.runtimeCodeHash, decimals, symbol, blockNumber: verified.blockNumber };
  }));
  const firstToken = tokens[0];
  const secondToken = tokens[1];
  if (firstToken === undefined || secondToken === undefined) throw new Error("Two fixture tokens are required");
  const contract = (name: (typeof contractNames)[number]) => {
    const value = Object.fromEntries(contractEntries)[name];
    if (value === undefined) throw new Error(`Missing verified ${name} deployment`);
    return value;
  };
  const contractFields = (name: (typeof contractNames)[number]) => {
    const { address, runtimeCodeHash } = contract(name);
    return { address, runtimeCodeHash };
  };
  const deploymentBlock = [...contractEntries.map(([, value]) => value.blockNumber), ...tokens.map((token) => token.blockNumber)]
    .reduce((maximum, block) => block > maximum ? block : maximum, 0n);
  const facilitatorUrl = `${publicOrigin}/facilitator`;
  const base = {
    schemaVersion: 1 as const, profile: "production" as const, runId: randomUUID(), createdAt: new Date().toISOString(),
    chain: { id: PUBLIC_CHAIN_ID, rpcUrl: primary, genesisHash: genesis.hash, deploymentBlock: deploymentBlock.toString(10) },
    services: { databaseUrl, apiUrl: publicOrigin, facilitatorUrl, brokerSocket: "env://signer" },
    auth: { issuer: publicOrigin, resource: publicOrigin, rpId: originUrl.hostname, origin: publicOrigin, pasetoPublicKeys: [identity.pasetoPublicKey] },
    contracts: {
      aqua: contractFields("aqua"), aquaSwapRouter: contractFields("aquaSwapRouter"),
      limitSwapRouter: contractFields("limitSwapRouter"), wrappedNativeToken: contractFields("wrappedNativeToken"),
      intentController: contractFields("intentController"), orderVaultFactory: contractFields("orderVaultFactory"),
      boundedMatcher: contractFields("boundedMatcher"), permit2: contractFields("permit2"),
      x402ExactPermit2Proxy: contractFields("x402ExactPermit2Proxy"),
    },
    fixtures: { tokens: tokens.map((token) => ({ address: token.address, runtimeCodeHash: token.runtimeCodeHash, decimals: token.decimals, symbol: token.symbol })), pairs: [
      { baseToken: firstToken.address, quoteToken: secondToken.address },
      { baseToken: secondToken.address, quoteToken: firstToken.address },
    ] },
    indexer: { contracts: [contract("aqua").address, contract("aquaSwapRouter").address, contract("intentController").address], startBlock: deploymentBlock.toString(10), confirmations: 6 },
    keeper: {
      allowedTargets: [contract("intentController").address, contract("orderVaultFactory").address, contract("boundedMatcher").address],
      allowedSelectors: ["0xb1b0923a", "0x5f330b0f", "0x95d5857e", "0xc8d18a45", "0xeeabec06", "0xf15d634f"],
    },
    secrets: { agent: "broker://agent", facilitator: "broker://facilitator", keeper: "broker://keeper", paseto: "broker://paseto" },
  };
  const parsed = runtimeManifestSchema.parse(base);
  const manifest: RuntimeManifest = runtimeManifestSchema.parse({ ...parsed, manifestHash: runtimeManifestHash(parsed) });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log("Ethereum Sepolia deployment complete", { manifest: manifestPath, hash: manifest.manifestHash });
};

const persistEvidence = async (
  verifiedContracts: z.infer<typeof contractsSchema>,
  tokenA: Deployed,
  tokenB: Deployed,
  seedTransactions: readonly string[],
  seedOrders: readonly { readonly orderHash: string; readonly transactionHash: string }[],
): Promise<void> => {
  const databaseUrl = env("DATABASE_URL");
  const deployments = {
    contracts: verifiedContracts, tokens: [tokenA, tokenB], seedTransactions, seedOrders, pasetoPublicKeys: [identity.pasetoPublicKey],
    keeperAddress: identity.keeper, brokerSocket: "env://signer", databaseUrl,
  };
  await Bun.write(deploymentsPath, `${JSON.stringify(deployments, null, 2)}\n`);
  const addresses = {
    ...Object.fromEntries(Object.entries(verifiedContracts).map(([name, deployment]) => [name, deployment.address])),
    tokenA: tokenA.address, tokenB: tokenB.address,
  };
  await Bun.write(addressesPath, `${JSON.stringify(addresses, null, 2)}\n`);
  await writeManifest(verifiedContracts, tokenA, tokenB);
};

const reusePinnedDeployment = async (): Promise<boolean> => {
  const pinned = [
    PINNED_AQUA, PINNED_AQUA_SWAP_ROUTER, PINNED_LIMIT_SWAP_ROUTER, SEPOLIA_WETH,
    PINNED_INTENT_CONTROLLER, PINNED_ORDER_VAULT_FACTORY, PINNED_BOUNDED_MATCHER,
    PERMIT2_ADDRESS, X402_EXACT_PROXY_ADDRESS, PINNED_TOKEN_A, PINNED_TOKEN_B,
  ];
  if (!(await Promise.all(pinned.map(async (address) => hasCode(address)))).every(Boolean)) return false;
  const aqua = await existingAt(PINNED_AQUA);
  const aquaSwapRouter = await existingAt(PINNED_AQUA_SWAP_ROUTER);
  const limitSwapRouter = await existingAt(PINNED_LIMIT_SWAP_ROUTER);
  const wrappedNativeToken = await existingAt(SEPOLIA_WETH);
  const intentController = await existingAt(PINNED_INTENT_CONTROLLER);
  const orderVaultFactory = await existingAt(PINNED_ORDER_VAULT_FACTORY);
  const boundedMatcher = await existingAt(PINNED_BOUNDED_MATCHER);
  const permit2 = await existingAt(PERMIT2_ADDRESS);
  const x402ExactPermit2Proxy = await existingAt(X402_EXACT_PROXY_ADDRESS, "create2");
  const tokenA = await existingAt(PINNED_TOKEN_A);
  const tokenB = await existingAt(PINNED_TOKEN_B);
  const verifiedContracts = contractsSchema.parse({
    aqua, aquaSwapRouter, limitSwapRouter, wrappedNativeToken, intentController,
    orderVaultFactory, boundedMatcher, permit2, x402ExactPermit2Proxy,
  });
  await assertDeploymentBindings(verifiedContracts, [tokenA, tokenB], { requireFixtureSupply: false });
  await persistEvidence(verifiedContracts, tokenA, tokenB, [], []);
  log("reusing pinned Ethereum Sepolia contracts", { addresses: addressesPath });
  return true;
};

const deploy = async (): Promise<void> => {
  if (await validateRecordedDeployment()) {
    log("reusing fully validated public-chain deployment", { addresses: addressesPath });
    return;
  }
  if (await rpc.chainId() !== PUBLIC_CHAIN_ID) throw new Error(`Public deployment is restricted to Ethereum Sepolia chain ${String(PUBLIC_CHAIN_ID)}`);
  if (!await hasCode(PERMIT2_ADDRESS)) throw new Error(`Canonical Permit2 runtime is missing at ${PERMIT2_ADDRESS}`);
  if (!await hasCode(CREATE2_DEPLOYER)) throw new Error(`Canonical CREATE2 deployer is missing at ${CREATE2_DEPLOYER}`);
  if (!await hasCode(SEPOLIA_WETH)) throw new Error(`Sepolia WETH is missing at ${SEPOLIA_WETH}`);
  if (await reusePinnedDeployment()) return;
  await requireFunded(deployerAddress(), "deployer");
  gasPriceWei = await resolveGasPrice();
  const upstream = upstreamSources();

  const aqua = await reuseOrCreate("aqua", async () => await hasCode(PINNED_AQUA)
    ? existingAt(PINNED_AQUA)
    : (async () => {
      const aquaDir = `${buildDir}/aqua`;
      await prepareCopy(upstream.aqua, aquaDir);
      await run(["bun", "install"], aquaDir);
      return forgeCreate({ cwd: aquaDir, contractPath: "src/AquaRouter.sol", contractName: "AquaRouter", constructorArgs: [deployerAddress()] });
    })());
  log("using Aqua registry", { address: aqua.address, installation: aqua.installation });

  const wrappedNativeToken = await reuseOrCreate("wrappedNativeToken", () => existingAt(SEPOLIA_WETH));
  const permit2 = await reuseOrCreate("permit2", () => existingAt(PERMIT2_ADDRESS));

  const swapvmDir = `${buildDir}/swapvm`;
  await prepareCopy(upstream.swapvm, swapvmDir);
  await run(["bun", "install"], swapvmDir);
  const swapVmConstructorArgs = [aqua.address, wrappedNativeToken.address, deployerAddress(), "SwapVMRouter", "1.0.0"];
  const aquaSwapRouter = await reuseOrCreate("aquaSwapRouter", async () => {
    if (await hasCode(PINNED_AQUA_SWAP_ROUTER)
      && sameAddress(await castCall(PINNED_AQUA_SWAP_ROUTER, "AQUA()(address)"), aqua.address)) {
      log("reusing pinned AquaSwapVMRouter", { address: PINNED_AQUA_SWAP_ROUTER });
      return existingAt(PINNED_AQUA_SWAP_ROUTER);
    }
    return forgeCreate({ cwd: swapvmDir, contractPath: "src/routers/AquaSwapVMRouter.sol", contractName: "AquaSwapVMRouter", constructorArgs: swapVmConstructorArgs });
  });
  const limitSwapRouter = await reuseOrCreate("limitSwapRouter", async () => await hasCode(PINNED_LIMIT_SWAP_ROUTER)
    ? existingAt(PINNED_LIMIT_SWAP_ROUTER)
    : forgeCreate({ cwd: swapvmDir, contractPath: "src/routers/LimitSwapVMRouter.sol", contractName: "LimitSwapVMRouter", constructorArgs: swapVmConstructorArgs }));

  const x402Dir = `${buildDir}/x402-evm`;
  await prepareCopy(`${upstream.x402}/contracts/evm`, x402Dir);
  const x402InitCode = (await Bun.file(`${x402Dir}/script/data/exact-proxy-initcode.hex`).text()).trim();
  if (!/^0x[0-9a-fA-F]+$/u.test(x402InitCode)) throw new Error("Pinned x402 init code is invalid");
  const x402ExactPermit2Proxy = await reuseOrCreate("x402ExactPermit2Proxy", async () => {
    let x402TransactionHash: Hash | undefined;
    if (!await hasCode(X402_EXACT_PROXY_ADDRESS)) {
      x402TransactionHash = await castSend(CREATE2_DEPLOYER, `${X402_EXACT_SALT}${x402InitCode.slice(2)}`);
    }
    if (!await hasCode(X402_EXACT_PROXY_ADDRESS)) throw new Error(`x402 exact proxy did not deploy at canonical address ${X402_EXACT_PROXY_ADDRESS}`);
    return {
      address: X402_EXACT_PROXY_ADDRESS, ...(x402TransactionHash === undefined ? {} : { transactionHash: x402TransactionHash }),
      blockNumber: x402TransactionHash === undefined ? await currentBlock() : await receiptBlock(x402TransactionHash), installation: "create2" as const,
    };
  });

  const fixturesDir = `${aquaRoot}/ops/local-fixtures`;
  const tokenA = await reuseOrCreate("tokenA", async () => await hasCode(PINNED_TOKEN_A)
    ? existingAt(PINNED_TOKEN_A)
    : forgeCreate({
      cwd: fixturesDir, contractPath: "src/FixtureERC20.sol", contractName: "FixtureERC20",
      constructorArgs: ["Aqua Fixture USD", "aUSD", "6", deployerAddress(), "1000000000000"],
    }));
  const tokenB = await reuseOrCreate("tokenB", async () => await hasCode(PINNED_TOKEN_B)
    ? existingAt(PINNED_TOKEN_B)
    : forgeCreate({
      cwd: fixturesDir, contractPath: "src/FixtureERC20.sol", contractName: "FixtureERC20",
      constructorArgs: ["Aqua Fixture ETH", "aETH", "18", deployerAddress(), "1000000000000000000000"],
    }));

  const contractsDir = `${aquaRoot}/contracts`;
  for (const name of ["AquaIntentController.sol", "AquaOrderVaultFactory.sol", "BoundedMatcher.sol"] as const) {
    if (!existsSync(`${contractsDir}/src/${name}`)) throw new Error(`Public-chain contract ${name} is missing from contracts/src`);
  }
  const intentController = await reuseOrCreate("intentController", async () => await hasCode(PINNED_INTENT_CONTROLLER)
    ? existingAt(PINNED_INTENT_CONTROLLER)
    : forgeCreate({
      cwd: contractsDir, contractPath: "src/AquaIntentController.sol", contractName: "AquaIntentController",
      constructorArgs: [identity.keeper, "1", "1"],
    }));
  const orderVaultFactory = await reuseOrCreate("orderVaultFactory", async () => await hasCode(PINNED_ORDER_VAULT_FACTORY)
    ? existingAt(PINNED_ORDER_VAULT_FACTORY)
    : forgeCreate({
      cwd: contractsDir, contractPath: "src/AquaOrderVaultFactory.sol", contractName: "AquaOrderVaultFactory",
    }));
  const boundedMatcher = await reuseOrCreate("boundedMatcher", async () => await hasCode(PINNED_BOUNDED_MATCHER)
    ? existingAt(PINNED_BOUNDED_MATCHER)
    : forgeCreate({
      cwd: contractsDir, contractPath: "src/BoundedMatcher.sol", contractName: "BoundedMatcher",
      constructorArgs: [
        identity.keeper,
        `[${aquaSwapRouter.address},${limitSwapRouter.address},${intentController.address},${intentController.address},${orderVaultFactory.address}]`,
        `[${SWAP_SELECTOR},${SWAP_SELECTOR},${ACTIVATE_SELECTOR},${OBSERVE_SELECTOR},${FACTORY_EXECUTE_SELECTOR}]`,
      ],
    }));
  if (!sameAddress(await castCall(intentController.address, "matcher()(address)"), boundedMatcher.address)) {
    await castSend(intentController.address, "bindMatcher(address)", [boundedMatcher.address]);
  }

  const contracts = { aqua, aquaSwapRouter, limitSwapRouter, wrappedNativeToken, intentController, orderVaultFactory, boundedMatcher, permit2, x402ExactPermit2Proxy };
  const verifiedContracts = contractsSchema.parse(contracts);
  await assertDeploymentBindings(verifiedContracts, [tokenA, tokenB], { requireFixtureSupply: false });
  const seedTransactions: string[] = [];
  for (const brokerAddress of [identity.agent, identity.facilitator, identity.keeper, FIXTURE_MAKER]) {
    if (await nativeBalance(brokerAddress) < MIN_FUNDED_WEI) {
      seedTransactions.push(await castSendValue(brokerAddress, MIN_FUNDED_WEI.toString(10)));
    }
    seedTransactions.push(await castSend(tokenA.address, "transfer(address,uint256)", [brokerAddress, "10000000000"]));
    seedTransactions.push(await castSend(tokenB.address, "transfer(address,uint256)", [brokerAddress, "10000000000000000000"]));
  }

  const protocol = new ProtocolService({
    chainId: PUBLIC_CHAIN_ID, aqua: verifiedContracts.aqua.address, aquaSwapRouter: verifiedContracts.aquaSwapRouter.address,
    limitSwapRouter: verifiedContracts.limitSwapRouter.address, wrappedNativeToken: verifiedContracts.wrappedNativeToken.address,
  }, rpc);
  const principal = { address: FIXTURE_MAKER, scopes: new Set(["trading:read" as const, "trading:write" as const]), sessionId: "ethereum-sepolia-fixture" };
  const fixtureOrders = [
    { sellToken: tokenA.address, buyToken: tokenB.address, sellAmount: "1000", buyAmount: "1", salt: `0x${"a1".repeat(32)}` },
    { sellToken: tokenB.address, buyToken: tokenA.address, sellAmount: "1", buyAmount: "1000", salt: `0x${"b2".repeat(32)}` },
  ] as const;
  const seedOrders: { readonly orderHash: string; readonly transactionHash: string }[] = [];
  for (const fixture of fixtureOrders) {
    const prepared = await protocol.prepareLimit(limitOrderRequestSchema.parse({
      ...fixture, timeInForce: "GTC", fillPolicy: "partial",
    }), principal);
    if (prepared.approval !== undefined) seedTransactions.push(await castSend(prepared.approval.to, prepared.approval.data, [], FIXTURE_MAKER_KEY));
    const transactionHash = await castSend(prepared.shipTransaction.to, prepared.shipTransaction.data, [], FIXTURE_MAKER_KEY);
    seedTransactions.push(transactionHash);
    seedOrders.push({ orderHash: prepared.orderHash, transactionHash });
  }

  await persistEvidence(verifiedContracts, tokenA, tokenB, seedTransactions, seedOrders);
};

try {
  await deploy();
} finally {
  proxy.stop();
}
