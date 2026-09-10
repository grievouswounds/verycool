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
  console.log(JSON.stringify({ level: "info", component: "deploy-local-chain", message, ...extra }));
};

initializeCubane();
const aquaRoot = env("AQUA_ROOT");
const stateDir = env("AQUA_STATE_DIR");
const rpcUrl = env("AQUA_LOCAL_RPC_URL");
const upstream = {
  aqua: env("AQUA_UPSTREAM"), swapvm: env("SWAPVM_UPSTREAM"),
  x402: env("X402_UPSTREAM"), permit2: env("PERMIT2_UPSTREAM"),
};
const buildDir = `${stateDir}/chain-build`;
const deploymentsPath = `${stateDir}/deployments.json`;
const addressesPath = `${stateDir}/deployment-addresses.json`;
const manifestPath = `${stateDir}/runtime-manifest.json`;

// Public Anvil account 0. It must never be used on a non-local chain.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER_ADDRESS = addressSchema.parse("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const FIXTURE_MAKER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const FIXTURE_MAKER = addressSchema.parse("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const PERMIT2_ADDRESS = addressSchema.parse("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const X402_EXACT_PROXY_ADDRESS = addressSchema.parse("0x402085c248eea27d92e8b30b2c58ed07f9e20001");
const CREATE2_DEPLOYER = addressSchema.parse("0x4e59b44847b379578588920cA78FbF26c0B4956C");
const X402_EXACT_SALT = "0x0000000000000000000000000000000000000000000000003000000007263b0e";
const SWAP_SELECTOR = "0xf4d2d412";
const ACTIVATE_SELECTOR = "0x5f330b0f";
const OBSERVE_SELECTOR = "0xb1b0923a";
const FACTORY_EXECUTE_SELECTOR = "0x95d5857e";
const PERMIT2_CACHED_CHAIN_ID_IMMEDIATE = "467f0000000000000000000000000000000000000000000000000000000000007a69";
const PERMIT2_REBUILD_CHAIN_ID_IMMEDIATE = "467f0000000000000000000000000000000000000000000000000000000000000001";
const word = (value: string): string => value.replace(/^0x/u, "").padStart(64, "0");
const permit2DomainSeparator = (chainId: bigint): string => {
  const typeHash = keccakHex(new TextEncoder().encode("EIP712Domain(string name,uint256 chainId,address verifyingContract)"));
  const nameHash = keccakHex(new TextEncoder().encode("Permit2"));
  return keccakHex(hexToBytes(hexSchema.parse(`0x${word(typeHash)}${word(nameHash)}${word(`0x${chainId.toString(16)}`)}${word(PERMIT2_ADDRESS)}`)));
};

const identity = z.object({
  agent: addressSchema, facilitator: addressSchema, keeper: addressSchema, pasetoPublicKey: z.string(),
}).parse(await Bun.file(`${stateDir}/identity.json`).json());
const rpc = new JsonRpcClient(new URL(rpcUrl), 10_000);

let rpcId = 0;
const rpcRequest = async (method: string, params: readonly unknown[]): Promise<unknown> => {
  const id = ++rpcId;
  const response = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(10_000),
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
  if (exitCode !== 0) throw new Error(`${command.join(" ")} (in ${cwd}) failed:\n${stderr.trim().slice(-2_000)}`);
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
  const receipt = z.object({ status: z.literal("0x1"), blockNumber: z.string() }).loose()
    .parse(await rpcRequest("eth_getTransactionReceipt", [transactionHash]));
  return BigInt(receipt.blockNumber).toString(10);
};
const currentBlock = async (): Promise<string> => BigInt(z.string().parse(await rpcRequest("eth_blockNumber", []))).toString(10);

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
  if (!sameAddress(await castCall(contracts.boundedMatcher.address, "operator()(address)"), identity.keeper)) throw new Error("Bounded matcher operator does not match broker keeper");
  for (const router of [contracts.aquaSwapRouter.address, contracts.limitSwapRouter.address]) {
    if (await castCall(contracts.boundedMatcher.address, "allowed(address,bytes4)(bool)", [router, SWAP_SELECTOR]) !== "true") throw new Error(`Bounded matcher does not allow swap on ${router}`);
  }
  if (await castCall(contracts.boundedMatcher.address, "allowed(address,bytes4)(bool)", [contracts.intentController.address, ACTIVATE_SELECTOR]) !== "true") throw new Error("Bounded matcher does not allow intent activate");
  if (await castCall(contracts.boundedMatcher.address, "allowed(address,bytes4)(bool)", [contracts.intentController.address, OBSERVE_SELECTOR]) !== "true") throw new Error("Bounded matcher does not allow intent observe");
  if (await castCall(contracts.boundedMatcher.address, "allowed(address,bytes4)(bool)", [contracts.orderVaultFactory.address, FACTORY_EXECUTE_SELECTOR]) !== "true") throw new Error("Bounded matcher does not allow vault factory execute");
  if (!sameAddress(await castCall(contracts.x402ExactPermit2Proxy.address, "PERMIT2()(address)"), PERMIT2_ADDRESS)) throw new Error("x402 exact proxy is not bound to canonical Permit2");
  const permit2Separator = hashSchema.parse((await castCall(contracts.permit2.address, "DOMAIN_SEPARATOR()(bytes32)")).trim().split(/\s+/u)[0] ?? "");
  if (permit2Separator !== permit2DomainSeparator(31337n)) throw new Error("Permit2 DOMAIN_SEPARATOR does not match canonical Permit2 on Anvil");
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
    log("recorded deployment is incomplete or stale; redeploying", { reason: error instanceof Error ? error.message : String(error) });
    return false;
  }
};

if (await validateRecordedDeployment()) {
  log("reusing fully validated local chain deployment", { addresses: addressesPath });
  process.exit(0);
}
if (await rpc.chainId() !== 31_337) throw new Error("Local deployment is restricted to Anvil chain 31337");

const permit2Dir = `${buildDir}/permit2`;
await prepareCopy(upstream.permit2, permit2Dir);
// Use the exact precompiled runtime shipped by Permit2's own Anvil test helper. Compiling the
// contract again is not equivalent because its EIP-712 cache contains constructor-patched immutables.
// That cache was computed for whatever address originally produced the hex, not the canonical
// Permit2 address, so invalidate the cached chain id and let DOMAIN_SEPARATOR recompute in place.
const permit2Helper = await Bun.file(`${permit2Dir}/test/utils/DeployPermit2.sol`).text();
const permit2Runtime = `0x${/bytes memory bytecode\s*=\s*hex"([0-9a-fA-F]+)"/u.exec(permit2Helper)?.[1] ?? ""}`.toLowerCase();
if (!/^0x[0-9a-fA-F]+$/u.test(permit2Runtime)) throw new Error("Permit2 forge inspect returned invalid runtime bytecode");
if ((permit2Runtime.match(new RegExp(PERMIT2_CACHED_CHAIN_ID_IMMEDIATE, "g")) ?? []).length !== 1) {
  throw new Error("Permit2 runtime must contain exactly one Anvil-cached chain-id DOMAIN_SEPARATOR immediate");
}
const permit2RuntimeForAnvil = permit2Runtime.replace(PERMIT2_CACHED_CHAIN_ID_IMMEDIATE, PERMIT2_REBUILD_CHAIN_ID_IMMEDIATE);
await rpcRequest("anvil_setCode", [PERMIT2_ADDRESS, permit2RuntimeForAnvil]);
const permit2: Deployed = { address: PERMIT2_ADDRESS, blockNumber: await currentBlock(), installation: "anvil-set-code" };
if (await rpc.getCode(PERMIT2_ADDRESS) === "0x") throw new Error("Failed to install canonical Permit2 runtime code");

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
// v1.0.2 stores WETH in OnlyWethReceiver's private immutable; AQUA() is the public binding check.
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

const contracts = { aqua, aquaSwapRouter, limitSwapRouter, wrappedNativeToken: weth, intentController, orderVaultFactory, boundedMatcher, permit2, x402ExactPermit2Proxy };
const verifiedContracts = contractsSchema.parse(contracts);
await assertDeploymentBindings(verifiedContracts, [tokenA, tokenB]);
const seedTransactions: string[] = [];
for (const brokerAddress of [identity.agent, identity.facilitator, identity.keeper, FIXTURE_MAKER]) {
  await rpcRequest("anvil_setBalance", [brokerAddress, "0x8ac7230489e80000"]); // 10 ETH
  seedTransactions.push(await castSend(tokenA.address, "transfer(address,uint256)", [brokerAddress, "10000000000"]));
  seedTransactions.push(await castSend(tokenB.address, "transfer(address,uint256)", [brokerAddress, "10000000000000000000"]));
}

const protocol = new ProtocolService({
  chainId: 31_337, aqua: verifiedContracts.aqua.address, aquaSwapRouter: verifiedContracts.aquaSwapRouter.address,
  limitSwapRouter: verifiedContracts.limitSwapRouter.address, wrappedNativeToken: verifiedContracts.wrappedNativeToken.address,
}, rpc, () => new Date("2026-09-08T00:00:00.000Z"));
const principal = { address: FIXTURE_MAKER, scopes: new Set(["trading:read" as const, "trading:write" as const]), sessionId: "local-anvil-fixture" };
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

const deployments = {
  contracts, tokens: [tokenA, tokenB], seedTransactions, seedOrders, pasetoPublicKeys: [identity.pasetoPublicKey],
  keeperAddress: identity.keeper,
  brokerSocket: env("AQUA_BROKER_SOCKET"), databaseUrl: env("DATABASE_URL"),
  apiPort: Number(env("AQUA_API_PORT")), facilitatorPort: Number(env("AQUA_FACILITATOR_PORT")),
};
await Bun.write(deploymentsPath, `${JSON.stringify(deployments, null, 2)}\n`);
const addresses = {
  ...Object.fromEntries(Object.entries(contracts).map(([name, deployment]) => [name, deployment.address])),
  tokenA: tokenA.address, tokenB: tokenB.address,
};
await Bun.write(addressesPath, `${JSON.stringify(addresses, null, 2)}\n`);
log("local chain deployment and deterministic two-way liquidity complete", { ...addresses, seedTransactions, seedOrders });
