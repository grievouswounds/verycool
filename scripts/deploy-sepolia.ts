import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { addressSchema, hashSchema, hexSchema, limitOrderRequestSchema, runtimeManifestSchema } from "@aqua/core";
import { ProtocolService } from "@aqua/contracts";
import { hexToBytes, initializeCubane, JsonRpcClient, keccakHex } from "@aqua/evm";
import { z } from "zod";

const env = (name: string): string => {
  const value = Bun.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing required environment variable ${name}`);
  return value;
};
const log = (message: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ level: "info", component: "deploy-sepolia", message, ...extra }));
};

initializeCubane();
const aquaRoot = env("AQUA_ROOT");
const stateDir = env("AQUA_STATE_DIR");
const rpcUrl = env("AQUA_SEPOLIA_RPC_URL");
const broadcastRpc = Bun.env["AQUA_SEPOLIA_BROADCAST_RPC_URL"] || rpcUrl;
const deployerKey = env("AQUA_SEPOLIA_PRIVATE_KEY");
const ANVIL_DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
if (deployerKey.toLowerCase() === ANVIL_DEPLOYER_KEY) {
  throw new Error("Refuse to broadcast the well-known Anvil deployer key on Sepolia");
}
const upstream = {
  aqua: env("AQUA_UPSTREAM"), swapvm: env("SWAPVM_UPSTREAM"), x402: env("X402_UPSTREAM"),
};
const buildDir = `${stateDir}/chain-build`;
const deploymentsPath = `${stateDir}/deployments.json`;
const addressesPath = `${stateDir}/deployment-addresses.json`;
const manifestPath = `${stateDir}/runtime-manifest.json`;
const partialPath = `${stateDir}/deployments.partial.json`;
const legacyBroadcast = ["--legacy"] as const;

const SEPOLIA_CHAIN_ID = 11_155_111n;
const VANITY_AQUA = addressSchema.parse("0x1111113ccf1426a8e30e2bff5e005d929bf6a90a");
const VANITY_AQUA_SWAP_ROUTER = addressSchema.parse("0x111111338c5091e8440b67b168bae16a668ac0de");
const SEPOLIA_WETH = addressSchema.parse("0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14");
const PERMIT2_ADDRESS = addressSchema.parse("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const X402_EXACT_PROXY_ADDRESS = addressSchema.parse("0x402085c248eea27d92e8b30b2c58ed07f9e20001");
const CREATE2_DEPLOYER = addressSchema.parse("0x4e59b44847b379578588920cA78FbF26c0B4956C");
const X402_EXACT_SALT = "0x0000000000000000000000000000000000000000000000003000000007263b0e";
const SWAP_SELECTOR = "0xf4d2d412";
const ACTIVATE_SELECTOR = "0x5f330b0f";
const OBSERVE_SELECTOR = "0xb1b0923a";
const FACTORY_EXECUTE_SELECTOR = "0x95d5857e";
const word = (value: string): string => value.replace(/^0x/u, "").padStart(64, "0");
const permit2DomainSeparator = (chainId: bigint): string => {
  const typeHash = keccakHex(new TextEncoder().encode("EIP712Domain(string name,uint256 chainId,address verifyingContract)"));
  const nameHash = keccakHex(new TextEncoder().encode("Permit2"));
  return keccakHex(hexToBytes(hexSchema.parse(`0x${word(typeHash)}${word(nameHash)}${word(`0x${chainId.toString(16)}`)}${word(PERMIT2_ADDRESS)}`)));
};

const identity = z.object({
  agent: addressSchema, facilitator: addressSchema, keeper: addressSchema, pasetoPublicKey: z.string(),
}).parse(await Bun.file(`${stateDir}/identity.json`).json());
const rpc = new JsonRpcClient(new URL(rpcUrl), 60_000);

let rpcId = 0;
const rpcRequest = async (method: string, params: readonly unknown[]): Promise<unknown> => {
  const id = ++rpcId;
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "aqua-probe/1" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`RPC ${method} returned HTTP ${String(response.status)}`);
  const body = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() }).parse(await response.json());
  if (body.id !== id || body.error !== undefined) throw new Error(`RPC ${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
};

const run = async (command: readonly string[], cwd: string): Promise<string> => {
  const proc = Bun.spawn([...command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (exitCode !== 0) {
    const rendered = command.map((part) => part === deployerKey ? "<redacted>" : part).join(" ");
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

type Installation = "create" | "create2" | "anvil-set-code";
interface Deployed {
  readonly address: string;
  readonly transactionHash?: string | undefined;
  readonly blockNumber: string;
  readonly installation: Installation;
}
const deploymentSchema = z.object({
  address: addressSchema, transactionHash: hashSchema.optional(),
  blockNumber: z.string().regex(/^(?:0|[1-9][0-9]*)$/u), installation: z.enum(["create", "create2", "anvil-set-code"]),
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
  seedTransactions: z.array(hashSchema).min(10),
  seedOrders: z.array(z.object({ orderHash: hashSchema, transactionHash: hashSchema }).strict()).length(2),
}).loose();

const receiptBlock = async (transactionHash: string): Promise<string> => {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await rpcRequest("eth_getTransactionReceipt", [transactionHash]);
    if (receipt !== null && receipt !== undefined) {
      return BigInt(z.object({ status: z.literal("0x1"), blockNumber: z.string() }).loose().parse(receipt).blockNumber).toString(10);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Timed out waiting for receipt ${transactionHash}`);
};
const currentBlock = async (): Promise<string> => BigInt(z.string().parse(await rpcRequest("eth_blockNumber", []))).toString(10);
const hasCode = async (address: string): Promise<boolean> => (await rpc.getCode(address)) !== "0x";
const existingAt = async (address: string, installation: Installation = "create"): Promise<Deployed> => {
  if (!await hasCode(address)) throw new Error(`Expected runtime code at ${address}`);
  return { address, blockNumber: await currentBlock(), installation };
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
    log(`reusing ${name} from partial Sepolia deployment`, recorded);
    return recorded;
  }
  return savePartial(name, await create());
};

const deployerAddress = addressSchema.parse((await run(
  ["cast", "wallet", "address", "--private-key", deployerKey], aquaRoot,
)).trim());

const forgeCreate = async (options: {
  readonly cwd: string; readonly contractPath: string; readonly contractName: string; readonly constructorArgs?: readonly string[];
}): Promise<Deployed> => {
  const args = [
    "forge", "create", `${options.contractPath}:${options.contractName}`,
    "--rpc-url", broadcastRpc, "--private-key", deployerKey, "--broadcast",
    ...legacyBroadcast, "--gas-limit", "5000000", "--gas-price", "2gwei",
  ];
  if (options.constructorArgs !== undefined && options.constructorArgs.length > 0) {
    args.push("--constructor-args", ...options.constructorArgs);
  }
  const stdout = await run(args, options.cwd);
  const address = addressSchema.parse(/Deployed to: (0x[0-9a-fA-F]{40})/u.exec(stdout)?.[1]);
  const transactionHash = hashSchema.parse(/Transaction hash: (0x[0-9a-fA-F]{64})/u.exec(stdout)?.[1]);
  const deployed = { address, transactionHash, blockNumber: await receiptBlock(transactionHash), installation: "create" as const };
  log(`deployed ${options.contractName}`, deployed);
  return deployed;
};

const nextNonce = async (): Promise<string> =>
  BigInt(z.string().parse(await rpcRequest("eth_getTransactionCount", [deployerAddress, "pending"]))).toString(10);

const publishSigned = async (raw: string): Promise<string> => {
  const signed = hexSchema.parse(raw.trim().split(/\s+/u).at(-1));
  const broadcastUrl = Bun.env["AQUA_SEPOLIA_BROADCAST_RPC_URL"] ?? "https://gateway.tenderly.co/public/sepolia";
  const id = ++rpcId;
  const response = await fetch(broadcastUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "aqua-probe/1" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "eth_sendRawTransaction", params: [signed] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`broadcast RPC returned HTTP ${String(response.status)}`);
  const body = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() }).parse(await response.json());
  if (body.error !== undefined) throw new Error(`eth_sendRawTransaction failed: ${JSON.stringify(body.error)}`);
  const transactionHash = hashSchema.parse(body.result);
  await receiptBlock(transactionHash);
  return transactionHash;
};

const castSend = async (to: string, signatureOrData: string, args: readonly string[] = [], privateKey = deployerKey, gasLimit = "3000000"): Promise<string> => {
  const raw = await run([
    "cast", "mktx", to, signatureOrData, ...args,
    "--private-key", privateKey, "--legacy", "--gas-limit", gasLimit, "--gas-price", "2gwei",
    "--nonce", await nextNonce(), "--chain", "11155111",
  ], aquaRoot);
  return publishSigned(raw);
};
const castSendValue = async (to: string, wei: string): Promise<string> => {
  const raw = await run([
    "cast", "mktx", to, "--value", wei, "--private-key", deployerKey, "--legacy",
    "--gas-limit", "21000", "--gas-price", "2gwei", "--nonce", await nextNonce(), "--chain", "11155111",
  ], aquaRoot);
  return publishSigned(raw);
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
  if (permit2Separator !== permit2DomainSeparator(SEPOLIA_CHAIN_ID)) throw new Error("Permit2 DOMAIN_SEPARATOR does not match canonical Permit2 on Sepolia");
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

const validateRecordedDeployment = async (): Promise<boolean> => {
  if (!existsSync(deploymentsPath) || !existsSync(addressesPath)) return false;
  try {
    const evidence = evidenceSchema.parse(await Bun.file(deploymentsPath).json());
    if (evidence.contracts.permit2.address !== PERMIT2_ADDRESS || evidence.contracts.x402ExactPermit2Proxy.address !== X402_EXACT_PROXY_ADDRESS) return false;
    const all = [...Object.values(evidence.contracts), ...evidence.tokens];
    if (!(await Promise.all(all.map(async ({ address }) => (await rpc.getCode(address)) !== "0x"))).every(Boolean)) return false;
    for (const transactionHash of evidence.seedTransactions) {
      z.object({ status: z.literal("0x1") }).loose().parse(await rpcRequest("eth_getTransactionReceipt", [transactionHash]));
    }
    if (existsSync(manifestPath)) {
      const manifest = runtimeManifestSchema.parse(await Bun.file(manifestPath).json());
      if (manifest.profile !== "sepolia" || manifest.chain.id !== 11_155_111) return false;
      for (const name of contractNames) {
        const deployment = evidence.contracts[name];
        const recorded = manifest.contracts[name];
        const codeHash = keccakHex(hexToBytes(await rpc.getCode(deployment.address)));
        if (recorded.address !== deployment.address || recorded.runtimeCodeHash !== codeHash) return false;
      }
      for (const [index, deployment] of evidence.tokens.entries()) {
        const recorded = manifest.fixtures.tokens[index];
        if (recorded?.address !== deployment.address) return false;
        if (recorded.runtimeCodeHash !== keccakHex(hexToBytes(await rpc.getCode(deployment.address)))) return false;
      }
    }
    await assertDeploymentBindings(evidence.contracts, evidence.tokens);
    return true;
  } catch (error) {
    log("recorded Sepolia deployment is incomplete or stale; redeploying", { reason: error instanceof Error ? error.message : String(error) });
    return false;
  }
};

if (await validateRecordedDeployment()) {
  log("reusing fully validated Sepolia deployment", { addresses: addressesPath });
  process.exit(0);
}
if (await rpc.chainId() !== Number(SEPOLIA_CHAIN_ID)) throw new Error("Sepolia deployment is restricted to chain 11155111");
if (!await hasCode(PERMIT2_ADDRESS)) throw new Error(`Canonical Permit2 is missing on Sepolia at ${PERMIT2_ADDRESS}`);
if (!await hasCode(CREATE2_DEPLOYER)) throw new Error(`Canonical CREATE2 deployer is missing at ${CREATE2_DEPLOYER}`);
if (!await hasCode(SEPOLIA_WETH)) throw new Error(`Sepolia WETH is missing at ${SEPOLIA_WETH}`);

const aqua = await reuseOrCreate("aqua", async () => hasCode(VANITY_AQUA)
  ? existingAt(VANITY_AQUA)
  : (async () => {
    const aquaDir = `${buildDir}/aqua`;
    await prepareCopy(upstream.aqua, aquaDir);
    await run(["bun", "install"], aquaDir);
    return forgeCreate({ cwd: aquaDir, contractPath: "src/AquaRouter.sol", contractName: "AquaRouter", constructorArgs: [deployerAddress] });
  })());
log("using Aqua registry", aqua);

const wrappedNativeToken = await reuseOrCreate("wrappedNativeToken", () => existingAt(SEPOLIA_WETH));
const permit2: Deployed = await reuseOrCreate("permit2", () => existingAt(PERMIT2_ADDRESS));

const swapvmDir = `${buildDir}/swapvm`;
await prepareCopy(upstream.swapvm, swapvmDir);
await run(["bun", "install"], swapvmDir);
const swapVmConstructorArgs = [aqua.address, wrappedNativeToken.address, deployerAddress, "SwapVMRouter", "1.0.0"];
const aquaSwapRouter = await reuseOrCreate("aquaSwapRouter", async () => {
  if (await hasCode(VANITY_AQUA_SWAP_ROUTER)
    && sameAddress(await castCall(VANITY_AQUA_SWAP_ROUTER, "AQUA()(address)"), aqua.address)) {
    log("reusing vanity AquaSwapVMRouter bound to discovered Aqua", { address: VANITY_AQUA_SWAP_ROUTER });
    return existingAt(VANITY_AQUA_SWAP_ROUTER);
  }
  return forgeCreate({ cwd: swapvmDir, contractPath: "src/routers/AquaSwapVMRouter.sol", contractName: "AquaSwapVMRouter", constructorArgs: swapVmConstructorArgs });
});
const limitSwapRouter = await reuseOrCreate("limitSwapRouter", () => forgeCreate({ cwd: swapvmDir, contractPath: "src/routers/LimitSwapVMRouter.sol", contractName: "LimitSwapVMRouter", constructorArgs: swapVmConstructorArgs }));

const x402Dir = `${buildDir}/x402-evm`;
await prepareCopy(`${upstream.x402}/contracts/evm`, x402Dir);
const x402InitCode = (await Bun.file(`${x402Dir}/script/data/exact-proxy-initcode.hex`).text()).trim();
if (!/^0x[0-9a-fA-F]+$/u.test(x402InitCode)) throw new Error("Pinned x402 init code is invalid");
const x402ExactPermit2Proxy = await reuseOrCreate("x402ExactPermit2Proxy", async () => {
  let x402TransactionHash: string | undefined;
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
const tokenA = await reuseOrCreate("tokenA", () => forgeCreate({ cwd: fixturesDir, contractPath: "src/FixtureERC20.sol", contractName: "FixtureERC20", constructorArgs: ["Aqua Fixture USD", "aUSD", "6", deployerAddress, "1000000000000"] }));
const tokenB = await reuseOrCreate("tokenB", () => forgeCreate({ cwd: fixturesDir, contractPath: "src/FixtureERC20.sol", contractName: "FixtureERC20", constructorArgs: ["Aqua Fixture ETH", "aETH", "18", deployerAddress, "1000000000000000000000"] }));

const contractsDir = `${aquaRoot}/contracts`;
const intentController = await reuseOrCreate("intentController", () => forgeCreate({ cwd: contractsDir, contractPath: "src/AquaIntentController.sol", contractName: "AquaIntentController", constructorArgs: [identity.keeper, "1", "1"] }));
const orderVaultFactory = await reuseOrCreate("orderVaultFactory", () => forgeCreate({ cwd: contractsDir, contractPath: "src/AquaOrderVaultFactory.sol", contractName: "AquaOrderVaultFactory" }));
const boundedMatcher = await reuseOrCreate("boundedMatcher", () => forgeCreate({
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
await assertDeploymentBindings(verifiedContracts, [tokenA, tokenB]);
const seedTransactions: string[] = [];
const seedWei = "20000000000000000";
for (const brokerAddress of [identity.agent, identity.facilitator, identity.keeper]) {
  seedTransactions.push(await castSendValue(brokerAddress, seedWei));
  seedTransactions.push(await castSend(tokenA.address, "transfer(address,uint256)", [brokerAddress, "10000000000"], deployerKey, "100000"));
  seedTransactions.push(await castSend(tokenB.address, "transfer(address,uint256)", [brokerAddress, "10000000000000000000"], deployerKey, "100000"));
}

const protocol = new ProtocolService({
  chainId: Number(SEPOLIA_CHAIN_ID), aqua: verifiedContracts.aqua.address, aquaSwapRouter: verifiedContracts.aquaSwapRouter.address,
  limitSwapRouter: verifiedContracts.limitSwapRouter.address, wrappedNativeToken: verifiedContracts.wrappedNativeToken.address,
}, rpc, () => new Date());
const principal = { address: deployerAddress, scopes: new Set(["trading:read" as const, "trading:write" as const]), sessionId: "sepolia-fixture" };
const fixtureOrders = [
  { sellToken: tokenA.address, buyToken: tokenB.address, sellAmount: "1000", buyAmount: "1", salt: `0x${"a1".repeat(32)}` },
  { sellToken: tokenB.address, buyToken: tokenA.address, sellAmount: "1", buyAmount: "1000", salt: `0x${"b2".repeat(32)}` },
] as const;
const seedOrders: { readonly orderHash: string; readonly transactionHash: string }[] = [];
for (const fixture of fixtureOrders) {
  const prepared = await protocol.prepareLimit(limitOrderRequestSchema.parse({
    ...fixture, timeInForce: "GTC", fillPolicy: "partial",
  }), principal);
  if (prepared.approval !== undefined) seedTransactions.push(await castSend(prepared.approval.to, prepared.approval.data, []));
  const transactionHash = await castSend(prepared.shipTransaction.to, prepared.shipTransaction.data, []);
  seedTransactions.push(transactionHash);
  seedOrders.push({ orderHash: prepared.orderHash, transactionHash });
}

const deployments = {
  contracts, tokens: [tokenA, tokenB], seedTransactions, seedOrders, pasetoPublicKeys: [identity.pasetoPublicKey],
  keeperAddress: identity.keeper,
  brokerSocket: env("AQUA_BROKER_SOCKET"), databaseUrl: env("DATABASE_URL"),
  apiPort: Number(env("AQUA_API_PORT")), facilitatorPort: Number(env("AQUA_FACILITATOR_PORT")),
};
await Bun.write(deploymentsPath, `${JSON.stringify(deployments, null, 2)}\n`);
const addresses = {
  ...Object.fromEntries(Object.entries(contracts).map(([name, deployment]) => [name, deployment.address])),
  tokenA: tokenA.address, tokenB: tokenB.address, deployer: deployerAddress,
};
await Bun.write(addressesPath, `${JSON.stringify(addresses, null, 2)}\n`);
log("Sepolia deployment complete", { ...addresses, seedTransactions, seedOrders, explorer: "https://sepolia.etherscan.io" });
