import { z } from "zod";

const workerConfigurationSchema = z.object({
  RPC_URL: z.url(),
  RPC_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  DATABASE_URL: z.url(),
  ACTIVITY_CONFIRMATIONS: z.coerce.number().int().min(0).max(10_000),
  ACTIVITY_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  ACTIVITY_BLOCK_CHUNK_SIZE: z.coerce.number().int().min(1).max(100_000).default(1000),
  ACTIVITY_SCAN_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
  ACTIVITY_WORKER_LEASE_SECONDS: z.coerce.number().int().min(60).max(3600).default(120),
}).strict();

export const loadWorkerConfiguration = (environment: Readonly<Record<string, string | undefined>>) => workerConfigurationSchema.parse({
  RPC_URL: environment["RPC_URL"], RPC_TIMEOUT_MS: environment["RPC_TIMEOUT_MS"],
  DATABASE_URL: environment["DATABASE_URL"],
  ACTIVITY_CONFIRMATIONS: environment["ACTIVITY_CONFIRMATIONS"],
  ACTIVITY_POLL_INTERVAL_SECONDS: environment["ACTIVITY_POLL_INTERVAL_SECONDS"],
  ACTIVITY_BLOCK_CHUNK_SIZE: environment["ACTIVITY_BLOCK_CHUNK_SIZE"],
  ACTIVITY_SCAN_CONCURRENCY: environment["ACTIVITY_SCAN_CONCURRENCY"],
  ACTIVITY_WORKER_LEASE_SECONDS: environment["ACTIVITY_WORKER_LEASE_SECONDS"],
});
