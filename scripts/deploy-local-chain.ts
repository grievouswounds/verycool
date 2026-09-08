import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { addressSchema, hashSchema } from "@aqua/core";
import { JsonRpcClient } from "@aqua/evm";

/**
 * Deploys the Aqua / SwapVM / x402 / Permit2 protocol stack plus two fixture ERC-20 tokens to a
 * local Anvil chain, and writes the `--deployments` JSON that `generate-local-manifest.ts`
 * consumes. This is the local-only counterpart to a real deployment: on a real chain, these
 * contracts are deployed once by their own maintainers (or a real deployment pipeline) and their
 * addresses are configuration, not something re-derived on every "dev" start.
 *
 * Requires, via environment variables:
 *   AQUA_ROOT, AQUA_STATE_DIR                         (already exported by the "dev" flow)
 *   AQUA_UPSTREAM, SWAPVM_UPSTREAM, X402_UPSTREAM, PERMIT2_UPSTREAM
 *                                                      (nix store paths to the pinned protocol sources)
 *   AQUA_LOCAL_RPC_URL, AQUA_BROKER_SOCKET, AQUA_API_PORT, AQUA_FACILITATOR_PORT, DATABASE_URL
 *
 * and expects `$AQUA_STATE_DIR/identity.json` (written by "secret-broker" at startup) to already
 * exist, since the on-chain AquaIntentController's immutable "operator" must be the broker's real
 * keeper address -- the same address that will later sign `observe`/`activate` calls.
 */

const env = (name: string): string => {
  const value = Bun.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing required environment variable ${name}`);
  return value;
};
const log = (message: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ level: "info", component: "deploy-local-chain", message, ...extra }));
};

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

// Anvil's well-known first "test test test ... junk" mnemonic account (index 0). Anvil prints
// this exact key at startup on every local chain; it is public and deterministic by design, so
// it is only ever safe to use as a throwaway local deployer that never holds real funds.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER_ADDRESS = addressSchema.parse("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

const identity = z.object({
  agent: addressSchema, facilitator: addressSchema, keeper: addressSchema,
  pasetoPublicKey: z.string(),
}).parse(await Bun.file(`${stateDir}/identity.json`).json());

const rpc = new JsonRpcClient(new URL(rpcUrl), 10_000);

const alreadyDeployed = async (): Promise<boolean> => {
  if (!existsSync(deploymentsPath) || !existsSync(addressesPath)) return false;
  try {
    const recorded = z.object({ permit2: addressSchema }).loose().parse(await Bun.file(addressesPath).json());
    // Anvil state does not survive a chain wiped between runs (no --state persistence, or a
    // deliberately fresh AQUA_STATE_DIR); checking that code still exists at a previously
    // recorded address is what actually distinguishes "safe to reuse" from "stale record".
    return (await rpc.getCode(recorded.permit2)) !== "0x";
  } catch {
    return false;
  }
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
  // The nix store source is read-only; forge (build artifacts, cache) and bun (node_modules)
  // both need to write into their own copy of it.
  await run(["cp", "-r", source, dest], buildDir);
  await run(["chmod", "-R", "u+w", dest], buildDir);
};

const bunInstall = async (cwd: string): Promise<void> => {
  await run(["bun", "install"], cwd);
};

interface Deployed { readonly address: string; readonly transactionHash: string }
const forgeCreate = async (options: {
  readonly cwd: string; readonly contractPath: string; readonly contractName: string;
  readonly constructorArgs?: readonly string[];
}): Promise<Deployed> => {
  const args = [
    "forge", "create", `${options.contractPath}:${options.contractName}`,
    "--rpc-url", rpcUrl, "--private-key", DEPLOYER_KEY, "--broadcast",
  ];
  if (options.constructorArgs !== undefined && options.constructorArgs.length > 0) {
    args.push("--constructor-args", ...options.constructorArgs);
  }
  const stdout = await run(args, options.cwd);
  const address = /Deployed to: (0x[0-9a-fA-F]{40})/u.exec(stdout)?.[1];
  const transactionHash = /Transaction hash: (0x[0-9a-fA-F]{64})/u.exec(stdout)?.[1];
  if (address === undefined || transactionHash === undefined) {
    throw new Error(`Could not parse forge create output for ${options.contractName}:\n${stdout.trim().slice(-2_000)}`);
  }
  log(`deployed ${options.contractName}`, { address, transactionHash });
  return { address, transactionHash };
};

if (await alreadyDeployed()) {
  log("reusing existing local chain deployment", { addresses: addressesPath });
  process.exit(0);
}

// Permit2 -- deployed via a direct CREATE (not the packaged CREATE2 salt script) so its receipt
// carries a non-null contractAddress: generate-local-manifest.ts verifies each deployment by
// reading `receipt.contractAddress`, which is only ever populated for a transaction whose `to`
// field is empty (a direct contract-creation transaction). A CREATE2 deployment made through the
// canonical deterministic deployer instead targets that deployer contract, so its own top-level
// receipt has contractAddress=null even though the target contract really was created.
const permit2Dir = `${buildDir}/permit2`;
await prepareCopy(upstream.permit2, permit2Dir);
const permit2 = await forgeCreate({ cwd: permit2Dir, contractPath: "src/Permit2.sol", contractName: "Permit2" });

const aquaDir = `${buildDir}/aqua`;
await prepareCopy(upstream.aqua, aquaDir);
await bunInstall(aquaDir);
const aqua = await forgeCreate({
  cwd: aquaDir, contractPath: "src/AquaRouter.sol", contractName: "AquaRouter",
  constructorArgs: [DEPLOYER_ADDRESS],
});

// WETH9 + two fixture ERC-20 tokens live in this repo (ops/local-fixtures), not upstream, since
// no upstream input ships a wrapped-native-token or mintable test token.
const fixturesDir = `${aquaRoot}/ops/local-fixtures`;
const weth = await forgeCreate({ cwd: fixturesDir, contractPath: "src/WETH9.sol", contractName: "WETH9" });
const tokenA = await forgeCreate({
  cwd: fixturesDir, contractPath: "src/FixtureERC20.sol", contractName: "FixtureERC20",
  constructorArgs: ["Aqua Fixture USD", "aUSD", "6", DEPLOYER_ADDRESS, "1000000000000"],
});
const tokenB = await forgeCreate({
  cwd: fixturesDir, contractPath: "src/FixtureERC20.sol", contractName: "FixtureERC20",
  constructorArgs: ["Aqua Fixture ETH", "aETH", "18", DEPLOYER_ADDRESS, "1000000000000000000000"],
});

const swapvmDir = `${buildDir}/swapvm`;
await prepareCopy(upstream.swapvm, swapvmDir);
await bunInstall(swapvmDir);
const swapVmConstructorArgs = [aqua.address, weth.address, DEPLOYER_ADDRESS, "SwapVMRouter", "1.0.0"];
const aquaSwapRouter = await forgeCreate({
  cwd: swapvmDir, contractPath: "src/routers/AquaSwapVMRouter.sol", contractName: "AquaSwapVMRouter",
  constructorArgs: swapVmConstructorArgs,
});
const limitSwapRouter = await forgeCreate({
  cwd: swapvmDir, contractPath: "src/routers/LimitSwapVMRouter.sol", contractName: "LimitSwapVMRouter",
  constructorArgs: swapVmConstructorArgs,
});

const x402Dir = `${buildDir}/x402-evm`;
await prepareCopy(`${upstream.x402}/contracts/evm`, x402Dir);
const x402ExactPermit2Proxy = await forgeCreate({
  cwd: x402Dir, contractPath: "src/x402ExactPermit2Proxy.sol", contractName: "x402ExactPermit2Proxy",
  constructorArgs: [permit2.address],
});

// The Ledger-vault wrapper contracts already live in, and are built by, this repo's own
// contracts/ Foundry project (deny="warnings"-clean); deploy straight from there rather than
// copying it, since it is always writable already.
const contractsDir = `${aquaRoot}/contracts`;
const intentController = await forgeCreate({
  cwd: contractsDir, contractPath: "src/AquaIntentController.sol", contractName: "AquaIntentController",
  // operator must be the secret-broker's real keeper address: it is the only account that will
  // ever be asked to sign observe()/activate() calls once the order-worker is running.
  constructorArgs: [identity.keeper, "1", "1"],
});
const orderVaultFactory = await forgeCreate({
  cwd: contractsDir, contractPath: "src/AquaOrderVaultFactory.sol", contractName: "AquaOrderVaultFactory",
});

const deployments = {
  transactions: {
    aqua: aqua.transactionHash,
    aquaSwapRouter: aquaSwapRouter.transactionHash,
    limitSwapRouter: limitSwapRouter.transactionHash,
    wrappedNativeToken: weth.transactionHash,
    intentController: intentController.transactionHash,
    orderVaultFactory: orderVaultFactory.transactionHash,
    permit2: permit2.transactionHash,
    x402ExactPermit2Proxy: x402ExactPermit2Proxy.transactionHash,
  },
  tokenTransactions: [tokenA.transactionHash, tokenB.transactionHash],
  pasetoPublicKeys: [identity.pasetoPublicKey],
  brokerSocket: env("AQUA_BROKER_SOCKET"),
  databaseUrl: env("DATABASE_URL"),
  apiPort: Number(env("AQUA_API_PORT")),
  facilitatorPort: Number(env("AQUA_FACILITATOR_PORT")),
};
await Bun.write(deploymentsPath, `${JSON.stringify(deployments, null, 2)}\n`);

const addresses = {
  aqua: aqua.address, aquaSwapRouter: aquaSwapRouter.address, limitSwapRouter: limitSwapRouter.address,
  wrappedNativeToken: weth.address, intentController: intentController.address,
  orderVaultFactory: orderVaultFactory.address, permit2: permit2.address,
  x402ExactPermit2Proxy: x402ExactPermit2Proxy.address, tokenA: tokenA.address, tokenB: tokenB.address,
};
await Bun.write(addressesPath, `${JSON.stringify(addresses, null, 2)}\n`);
hashSchema.parse(deployments.transactions.aqua); // Fails fast and loudly if forge output was ever mis-parsed above.
log("local chain deployment complete", addresses);
