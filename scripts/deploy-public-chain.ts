import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { addressSchema, hashSchema, hexSchema, limitOrderRequestSchema, runtimeManifestHash, runtimeManifestSchema } from "@aqua/core";
import type { RuntimeManifest } from "@aqua/core";
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

initializeCubane();
const aquaRoot = env("AQUA_ROOT");
const stateDir = env("AQUA_STATE_DIR");
const upstream = {
  aqua: env("AQUA_UPSTREAM"), swapvm: env("SWAPVM_UPSTREAM"),
  x402: env("X402_UPSTREAM"), permit2: env("PERMIT2_UPSTREAM"),
};
const buildDir = `${stateDir}/chain-build`;
const deploymentsPath = `${stateDir}/deployments.production.json`;
const addressesPath = `${stateDir}/deployment-addresses.production.json`;
const manifestPath = `${stateDir}/runtime-manifest.production.json`;
const PUBLIC_CHAIN_ID = ETHEREUM_SEPOLIA_CHAIN_ID;
const ANVIL_ACCOUNT_ZERO_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER_KEY = hexSchema.parse(env("AQUA_DEPLOYER_PRIVATE_KEY"));
if (DEPLOYER_KEY.toLowerCase() === ANVIL_ACCOUNT_ZERO_KEY) throw new Error("Refusing the public Anvil account-0 key on Ethereum Sepolia");
const DEPLOYER_ADDRESS = signingKeyAddress(DEPLOYER_KEY);
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
const fixtureMakerRaw = Bun.env["AQUA_FIXTURE_MAKER_KEY"]?.trim();
const FIXTURE_MAKER_KEY = hexSchema.parse(fixtureMakerRaw === undefined || fixtureMakerRaw.length === 0 ? agentKey : fixtureMakerRaw);
const FIXTURE_MAKER = signingKeyAddress(FIXTURE_MAKER_KEY);
const PERMIT2_ADDRESS = addressSchema.parse("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const X402_EXACT_PROXY_ADDRESS = addressSchema.parse("0x402085c248eea27d92e8b30b2c58ed07f9e20001");
const CREATE2_DEPLOYER = addressSchema.parse("0x4e59b44847b379578588920cA78FbF26c0B4956C");
const X402_EXACT_SALT = "0x0000000000000000000000000000000000000000000000003000000007263b0e";
const SWAP_SELECTOR = "0xf4d2d412";
const ACTIVATE_SELECTOR = "0x5f330b0f";
const OBSERVE_SELECTOR = "0xb1b0923a";
const FACTORY_EXECUTE_SELECTOR = "0x95d5857e";
const MIN_FUNDED_WEI = 10n ** 16n;
const word = (value: string): string => value.replace(/^0x/u, "").padStart(64, "0");
const permit2DomainSeparator = (chainId: bigint): string => {
  const typeHash = keccakHex(new TextEncoder().encode("EIP712Domain(string name,uint256 chainId,address verifyingContract)"));
  const nameHash = keccakHex(new TextEncoder().encode("Permit2"));
  return keccakHex(hexToBytes(hexSchema.parse(`0x${word(typeHash)}${word(nameHash)}${word(`0x${chainId.toString(16)}`)}${word(PERMIT2_ADDRESS)}`)));
};

await mkdir(stateDir, { recursive: true });
await Bun.write(`${stateDir}/identity.production.json`, `${JSON.stringify(identity, null, 2)}\n`);
const primary = primaryRpcUrl(PUBLIC_CHAIN_ID, "https://rpc.sepolia.org");
const rpc = createPooledRpcClient({ id: PUBLIC_CHAIN_ID, rpcUrl: primary }, 10_000);
const proxy = serveRpcProxy(rpc);
const rpcUrl = proxy.url;

const run = async (command: readonly string[], cwd: string): Promise<string> => {
  const proc = Bun.spawn([...command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} (in ${cwd}) failed:\n${stderr.trim().slice(-2_000)}`);
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
  readonly address: string;
  readonly transactionHash?: string | undefined;
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

const receiptBlock = async (transactionHash: string): Promise<string> => {
  const receipt = await rpc.transactionReceipt(hashSchema.parse(transactionHash));
  if (receipt?.status !== "success") throw new Error(`Missing successful receipt for ${transactionHash}`);
  return receipt.blockNumber.toString(10);
};
const currentBlock = async (): Promise<string> => (await rpc.blockNumber()).toString(10);
const nativeBalance = async (address: string): Promise<bigint> => rpc.balance(addressSchema.parse(address));
const requireFunded = async (address: string, label: string): Promise<void> => {
  const balance = await nativeBalance(address);
  if (balance < MIN_FUNDED_WEI) throw new Error(`${label} ${address} needs Ethereum Sepolia ETH (have ${balance.toString(10)} wei)`);
};

const forgeCreate = async (options: {
  readonly cwd: string; readonly contractPath: string; readonly contractName: string; readonly constructorArgs?: readonly string[];
}): Promise<Deployed> => {
  const args = ["forge", "create", `${options.contractPath}:${options.contractName}`, "--rpc-url", rpcUrl, "--private-key", DEPLOYER_KEY, "--broadcast"];
  if (options.constructorArgs !== undefined && options.constructorArgs.length > 0) args.push("--constructor-args", ...options.constructorArgs);
  const stdout = await run(args, options.cwd);
  const address = addressSchema.parse(/Deployed to: (0x[0-9a-fA-F]{40})/u.exec(stdout)?.[1]);
  const transactionHash = hashSchema.parse(/Transaction hash: (0x[0-9a-fA-F]{64})/u.exec(stdout)?.[1]);
  const deployed = { address, transactionHash, blockNumber: await receiptBlock(transactionHash), installation: "create" as const };
  log(`deployed ${options.contractName}`, deployed);
  return deployed;
};

const castSend = async (to: string, signatureOrData: string, args: readonly string[] = [], privateKey = DEPLOYER_KEY): Promise<string> => {
  const output = await run(["cast", "send", to, signatureOrData, ...args, "--rpc-url", rpcUrl, "--private-key", privateKey, "--json"], aquaRoot);
  return z.object({ transactionHash: hashSchema }).loose().parse(JSON.parse(output)).transactionHash;
};

const castCall = async (to: string, signature: string, args: readonly string[] = []): Promise<string> =>
  (await run(["cast", "call", to, signature, ...args, "--rpc-url", rpcUrl], aquaRoot)).trim();
const sameAddress = (actual: string, expected: string): boolean => actual.toLowerCase() === expected.toLowerCase();
const assertDeploymentBindings = async (contracts: z.infer<typeof contractsSchema>, tokens: readonly Deployed[]): Promise<void> => {
  for (const router of [contracts.aquaSwapRouter.address, contracts.limitSwapRouter.address]) {
    if (!sameAddress(await castCall(router, "AQUA()(address)"), contracts.aqua.address)) throw new Error(`Router ${router} has the wrong Aqua binding`);
  }
  if (!sameAddress(await castCall(contracts.intentController.address, "operator()(address)"), identity.keeper)) throw new Error("Intent controller operator does not match broker keeper");
  if (!sameAddress(await castCall(contracts.intentController.address, "matcher()(address)"), contracts.boundedMatcher.address)) throw new Error("Intent controller matcher is not bound to the bounded matcher");
  if (!sameAddress(await castCall(contracts.boundedMatcher.address, "operator()(address)"), identity.keeper)) throw new Error("Bounded matcher operator does not match broker keeper");
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
    if (symbol.replace(/^"|"$/gu, "") !== expected.symbol || decimals !== expected.decimals
      || supply.split(" ")[0] !== expected.supply) throw new Error(`Fixture token ${token.address} metadata or supply is invalid`);
  }
};

if (await rpc.chainId() !== PUBLIC_CHAIN_ID) throw new Error(`Public deployment is restricted to Ethereum Sepolia chain ${String(PUBLIC_CHAIN_ID)}`);
await requireFunded(DEPLOYER_ADDRESS, "deployer");
if (await rpc.getCode(PERMIT2_ADDRESS) === "0x") throw new Error(`Canonical Permit2 runtime is missing at ${PERMIT2_ADDRESS}`);
const permit2: Deployed = { address: PERMIT2_ADDRESS, blockNumber: await currentBlock(), installation: "preexisting" };

const aquaDir = `${buildDir}/aqua`;
await prepareCopy(upstream.aqua, aquaDir);
await run(["bun", "install"], aquaDir);
const aqua = await forgeCreate({ cwd: aquaDir, contractPath: "src/AquaRouter.sol", contractName: "AquaRouter", constructorArgs: [DEPLOYER_ADDRESS] });

const fixturesDir = `${aquaRoot}/ops/local-fixtures`;
const weth = await forgeCreate({ cwd: fixturesDir, contractPath: "src/WETH9.sol", contractName: "WETH9" });
const tokenA = await forgeCreate({ cwd: fixturesDir, contractPath: "src/FixtureERC20.sol", contractName: "FixtureERC20", constructorArgs: ["Aqua Fixture USD", "aUSD", "6", DEPLOYER_ADDRESS, "1000000000000"] });
const tokenB = await forgeCreate({ cwd: fixturesDir, contractPath: "src/FixtureERC20.sol", contractName: "FixtureERC20", constructorArgs: ["Aqua Fixture ETH", "aETH", "18", DEPLOYER_ADDRESS, "1000000000000000000000"] });

const swapvmDir = `${buildDir}/swapvm`;
await prepareCopy(upstream.swapvm, swapvmDir);
await run(["bun", "install"], swapvmDir);
const swapVmConstructorArgs = [aqua.address, weth.address, DEPLOYER_ADDRESS, "SwapVMRouter", "1.0.0"];
const aquaSwapRouter = await forgeCreate({ cwd: swapvmDir, contractPath: "src/routers/AquaSwapVMRouter.sol", contractName: "AquaSwapVMRouter", constructorArgs: swapVmConstructorArgs });
const limitSwapRouter = await forgeCreate({ cwd: swapvmDir, contractPath: "src/routers/LimitSwapVMRouter.sol", contractName: "LimitSwapVMRouter", constructorArgs: swapVmConstructorArgs });

const x402Dir = `${buildDir}/x402-evm`;
await prepareCopy(`${upstream.x402}/contracts/evm`, x402Dir);
if (await rpc.getCode(CREATE2_DEPLOYER) === "0x") throw new Error(`Canonical CREATE2 deployer is missing at ${CREATE2_DEPLOYER}`);
const x402InitCode = (await Bun.file(`${x402Dir}/script/data/exact-proxy-initcode.hex`).text()).trim();
if (!/^0x[0-9a-fA-F]+$/u.test(x402InitCode)) throw new Error("Pinned x402 init code is invalid");
let x402TransactionHash: string | undefined;
if (await rpc.getCode(X402_EXACT_PROXY_ADDRESS) === "0x") x402TransactionHash = await castSend(CREATE2_DEPLOYER, `${X402_EXACT_SALT}${x402InitCode.slice(2)}`);
if (await rpc.getCode(X402_EXACT_PROXY_ADDRESS) === "0x") throw new Error(`x402 exact proxy did not deploy at canonical address ${X402_EXACT_PROXY_ADDRESS}`);
const x402ExactPermit2Proxy: Deployed = {
  address: X402_EXACT_PROXY_ADDRESS, ...(x402TransactionHash === undefined ? {} : { transactionHash: x402TransactionHash }),
  blockNumber: x402TransactionHash === undefined ? await currentBlock() : await receiptBlock(x402TransactionHash), installation: "create2",
};

const contractsDir = `${aquaRoot}/contracts`;
for (const name of ["AquaIntentController.sol", "AquaOrderVaultFactory.sol", "BoundedMatcher.sol"] as const) {
  if (!existsSync(`${contractsDir}/src/${name}`)) throw new Error(`Public-chain contract ${name} is missing from contracts/src`);
}
const intentController = await forgeCreate({ cwd: contractsDir, contractPath: "src/AquaIntentController.sol", contractName: "AquaIntentController", constructorArgs: [identity.keeper, "1", "1"] });
const orderVaultFactory = await forgeCreate({ cwd: contractsDir, contractPath: "src/AquaOrderVaultFactory.sol", contractName: "AquaOrderVaultFactory" });
const boundedMatcher = await forgeCreate({
  cwd: contractsDir, contractPath: "src/BoundedMatcher.sol", contractName: "BoundedMatcher",
  constructorArgs: [
    identity.keeper,
    `[${aquaSwapRouter.address},${limitSwapRouter.address},${intentController.address},${intentController.address},${orderVaultFactory.address}]`,
    `[${SWAP_SELECTOR},${SWAP_SELECTOR},${ACTIVATE_SELECTOR},${OBSERVE_SELECTOR},${FACTORY_EXECUTE_SELECTOR}]`,
  ],
});
await castSend(intentController.address, "bindMatcher(address)", [boundedMatcher.address]);

const contracts = { aqua, aquaSwapRouter, limitSwapRouter, wrappedNativeToken: weth, intentController, orderVaultFactory, boundedMatcher, permit2, x402ExactPermit2Proxy };
const verifiedContracts = contractsSchema.parse(contracts);
await assertDeploymentBindings(verifiedContracts, [tokenA, tokenB]);
const seedTransactions: string[] = [];
for (const brokerAddress of [identity.agent, identity.facilitator, identity.keeper, FIXTURE_MAKER]) {
  await requireFunded(brokerAddress, "runtime signer");
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

const publicOrigin = (Bun.env["AQUA_PUBLIC_ORIGIN"] ?? Bun.env["AQUA_VERCEL_URL"] ?? "https://localhost").replace(/\/$/u, "");
const originUrl = new URL(publicOrigin);
const databaseUrl = env("DATABASE_URL");
const deployments = {
  contracts, tokens: [tokenA, tokenB], seedTransactions, seedOrders, pasetoPublicKeys: [identity.pasetoPublicKey],
  keeperAddress: identity.keeper, brokerSocket: "env://signer", databaseUrl,
};
await Bun.write(deploymentsPath, `${JSON.stringify(deployments, null, 2)}\n`);
const addresses = {
  ...Object.fromEntries(Object.entries(contracts).map(([name, deployment]) => [name, deployment.address])),
  tokenA: tokenA.address, tokenB: tokenB.address,
};
await Bun.write(addressesPath, `${JSON.stringify(addresses, null, 2)}\n`);

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
log("Ethereum Sepolia deployment complete", { ...addresses, manifest: manifestPath, hash: manifest.manifestHash });
