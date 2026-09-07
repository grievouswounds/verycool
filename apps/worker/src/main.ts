import { randomUUID } from "node:crypto";
import { ActivityCollector, RpcActivityChain } from "@aqua/activity";
import { PostgresActivityRepository, createDatabase, closeDatabase } from "@aqua/adapters";
import { initializeCubane, JsonRpcClient } from "@aqua/evm";
import { loadWorkerConfiguration } from "./config.ts";

const config = loadWorkerConfiguration(Bun.env);
initializeCubane();
const database = createDatabase(config.DATABASE_URL);
await database.connect();
const repository = new PostgresActivityRepository(database);
await repository.initialize();
const collector = new ActivityCollector(repository, new RpcActivityChain(new JsonRpcClient(new URL(config.RPC_URL), config.RPC_TIMEOUT_MS)), {
  confirmations: BigInt(config.ACTIVITY_CONFIRMATIONS), blockChunkSize: BigInt(config.ACTIVITY_BLOCK_CHUNK_SIZE),
  subscriptionBatchSize: config.ACTIVITY_SCAN_CONCURRENCY,
});
const holder = randomUUID();
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const tick = async (): Promise<void> => {
  const now = new Date();
  const until = new Date(now.getTime() + config.ACTIVITY_WORKER_LEASE_SECONDS * 1_000);
  if (await repository.acquireLease("erc20-activity", holder, now, until)) await collector.runOnce();
};

const schedule = (): void => {
  if (stopped) return;
  const interval = config.ACTIVITY_POLL_INTERVAL_SECONDS * 1_000;
  const delay = interval - Date.now() % interval;
  timer = setTimeout(() => {
    void tick().catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", component: "activity-worker", message: error instanceof Error ? error.message : "Unknown worker error" }));
    }).finally(schedule);
  }, delay);
};

await tick();
schedule();

const shutdown = async (): Promise<void> => {
  stopped = true;
  if (timer !== undefined) clearTimeout(timer);
  await closeDatabase(database);
};
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
