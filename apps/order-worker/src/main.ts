import { PostgresKeeperJobRepository, PostgresTradingRepository, createDatabase, closeDatabase } from "@aqua/adapters";
import { CubaneTransactionSigner, JsonRpcClient, initializeCubane } from "@aqua/evm";
import { Keeper, OrderBookIndexer, TriggerEvaluator } from "@aqua/orderbook";
import { hexSchema } from "@aqua/core";
import { randomUUID } from "node:crypto";
import { loadOrderWorkerConfiguration } from "./config.ts";

const config = loadOrderWorkerConfiguration(Bun.env);
initializeCubane();
const database = createDatabase(config.DATABASE_URL);
await database.connect();
const repository = new PostgresTradingRepository(database);
await repository.initialize();
const rpc = new JsonRpcClient(new URL(config.RPC_URL), config.RPC_TIMEOUT_MS);
const indexer = new OrderBookIndexer(repository, rpc, {
  chainId: config.CHAIN_ID,
  contracts: config.ORDERBOOK_CONTRACTS, startBlock: BigInt(config.ORDERBOOK_START_BLOCK),
  limitRouters: [config.LIMIT_SWAP_ROUTER_ADDRESS], pairs: config.ORDERBOOK_PAIRS,
  confirmations: BigInt(config.ORDERBOOK_CONFIRMATIONS), blockChunkSize: BigInt(config.ORDERBOOK_BLOCK_CHUNK_SIZE),
});
const keyText = (await Bun.file(config.KEEPER_PRIVATE_KEY_FILE).text()).trim();
if (keyText.length !== 66) throw new Error("Keeper secret file must contain one 32-byte hex key");
const signer = new CubaneTransactionSigner(hexSchema.parse(keyText));
const keeperRepository = new PostgresKeeperJobRepository(database);
await keeperRepository.initialize();
const keeper = new Keeper(keeperRepository, rpc, signer, {
  chainId: config.CHAIN_ID, allowedTargets: config.KEEPER_ALLOWED_TARGETS,
  allowedSelectors: config.KEEPER_ALLOWED_SELECTORS.map((value) => hexSchema.parse(value)), gasLimit: BigInt(config.KEEPER_GAS_LIMIT),
  maxFeePerGas: BigInt(config.KEEPER_MAX_FEE_GWEI) * 1_000_000_000n,
  replacementSeconds: config.KEEPER_REPLACEMENT_SECONDS, leaseSeconds: config.KEEPER_LEASE_SECONDS,
});
const triggers = new TriggerEvaluator(repository, keeperRepository, {
  controller: config.ORDER_CONTROLLER_ADDRESS,
  minimumBlocks: BigInt(config.TRIGGER_MINIMUM_BLOCKS), minimumSeconds: BigInt(config.TRIGGER_MINIMUM_SECONDS),
});
const workerId = randomUUID();
const runCycle = async (): Promise<void> => {
  await indexer.runOnce();
  const head = await rpc.blockNumber();
  if (head >= BigInt(config.ORDERBOOK_CONFIRMATIONS)) {
    const confirmed = await rpc.block(head - BigInt(config.ORDERBOOK_CONFIRMATIONS));
    await triggers.runOnce(confirmed.number, confirmed.timestamp);
  }
  await keeper.runOnce(workerId);
};
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const schedule = (): void => {
  if (stopped) return;
  timer = setTimeout(() => {
    void runCycle().catch((error: unknown) => {
      console.error(JSON.stringify({
        level: "error", component: "order-worker", message: error instanceof Error ? error.message : "Unknown worker error",
      }));
    }).finally(schedule);
  }, config.ORDERBOOK_POLL_INTERVAL_SECONDS * 1_000);
};
await runCycle();
schedule();
const shutdown = async (): Promise<void> => {
  stopped = true;
  if (timer !== undefined) clearTimeout(timer);
  await closeDatabase(database);
};
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
