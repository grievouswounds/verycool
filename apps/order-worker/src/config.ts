import { addressSchema, parseStrictJson } from "@aqua/core";
import { z } from "zod";

const integer = (minimum: number, maximum: number) => z.string().regex(/^(?:0|[1-9][0-9]*)$/u)
  .transform(Number).pipe(z.number().int().min(minimum).max(maximum));
const schema = z.object({
  CHAIN_ID: integer(1, Number.MAX_SAFE_INTEGER),
  RPC_URL: z.url(), RPC_TIMEOUT_MS: integer(100, 60_000).default(10_000),
  DATABASE_URL: z.url(),
  ORDERBOOK_CONTRACTS: z.string().transform((value, context) => {
    try { return z.array(addressSchema).min(1).max(16).parse(parseStrictJson(value)); }
    catch { context.addIssue({ code: "custom", message: "Expected a JSON array of 1-16 EVM addresses" }); return z.NEVER; }
  }).refine((addresses) => new Set(addresses).size === addresses.length, "Duplicate contract address"),
  LIMIT_SWAP_ROUTER_ADDRESS: addressSchema,
  ORDER_CONTROLLER_ADDRESS: addressSchema,
  ORDERBOOK_PAIRS: z.string().transform((value, context) => {
    try { return z.array(z.object({ baseToken: addressSchema, quoteToken: addressSchema }).strict()
      .refine((pair) => pair.baseToken !== pair.quoteToken, "Pair tokens must differ")).min(1).max(100).parse(parseStrictJson(value)); }
    catch { context.addIssue({ code: "custom", message: "Expected a JSON array of 1-100 strict token pairs" }); return z.NEVER; }
  }),
  ORDERBOOK_START_BLOCK: integer(0, Number.MAX_SAFE_INTEGER),
  ORDERBOOK_CONFIRMATIONS: integer(1, 10_000), ORDERBOOK_BLOCK_CHUNK_SIZE: integer(1, 10_000).default(500),
  ORDERBOOK_POLL_INTERVAL_SECONDS: integer(1, 60).default(2),
  KEEPER_PRIVATE_KEY_FILE: z.string().min(1).max(1024),
  KEEPER_ALLOWED_TARGETS: z.string().transform((value, context) => {
    try { return z.array(addressSchema).min(1).max(8).parse(parseStrictJson(value)); }
    catch { context.addIssue({ code: "custom", message: "Expected a JSON array of keeper targets" }); return z.NEVER; }
  }),
  KEEPER_ALLOWED_SELECTORS: z.string().transform((value, context) => {
    try { return z.array(z.string().regex(/^0x[0-9a-f]{8}$/u)).min(1).max(16).parse(parseStrictJson(value)); }
    catch { context.addIssue({ code: "custom", message: "Expected a JSON array of lowercase four-byte selectors" }); return z.NEVER; }
  }),
  KEEPER_GAS_LIMIT: integer(21_000, 30_000_000), KEEPER_MAX_FEE_GWEI: integer(1, 100_000),
  KEEPER_REPLACEMENT_SECONDS: integer(10, 3600).default(60), KEEPER_LEASE_SECONDS: integer(5, 300).default(30),
  TRIGGER_MINIMUM_BLOCKS: integer(1, 100).default(2), TRIGGER_MINIMUM_SECONDS: integer(1, 3600).default(30),
}).strict();
export type OrderWorkerConfiguration = z.infer<typeof schema>;
export const loadOrderWorkerConfiguration = (environment: Readonly<Record<string, string | undefined>>): OrderWorkerConfiguration => schema.parse({
  CHAIN_ID: environment["CHAIN_ID"],
  RPC_URL: environment["RPC_URL"], RPC_TIMEOUT_MS: environment["RPC_TIMEOUT_MS"],
  DATABASE_URL: environment["DATABASE_URL"],
  ORDERBOOK_CONTRACTS: environment["ORDERBOOK_CONTRACTS"], ORDERBOOK_START_BLOCK: environment["ORDERBOOK_START_BLOCK"],
  LIMIT_SWAP_ROUTER_ADDRESS: environment["LIMIT_SWAP_ROUTER_ADDRESS"], ORDER_CONTROLLER_ADDRESS: environment["ORDER_CONTROLLER_ADDRESS"],
  ORDERBOOK_PAIRS: environment["ORDERBOOK_PAIRS"],
  ORDERBOOK_CONFIRMATIONS: environment["ORDERBOOK_CONFIRMATIONS"], ORDERBOOK_BLOCK_CHUNK_SIZE: environment["ORDERBOOK_BLOCK_CHUNK_SIZE"],
  ORDERBOOK_POLL_INTERVAL_SECONDS: environment["ORDERBOOK_POLL_INTERVAL_SECONDS"],
  KEEPER_PRIVATE_KEY_FILE: environment["KEEPER_PRIVATE_KEY_FILE"], KEEPER_ALLOWED_TARGETS: environment["KEEPER_ALLOWED_TARGETS"],
  KEEPER_ALLOWED_SELECTORS: environment["KEEPER_ALLOWED_SELECTORS"], KEEPER_GAS_LIMIT: environment["KEEPER_GAS_LIMIT"],
  KEEPER_MAX_FEE_GWEI: environment["KEEPER_MAX_FEE_GWEI"], KEEPER_REPLACEMENT_SECONDS: environment["KEEPER_REPLACEMENT_SECONDS"],
  KEEPER_LEASE_SECONDS: environment["KEEPER_LEASE_SECONDS"],
  TRIGGER_MINIMUM_BLOCKS: environment["TRIGGER_MINIMUM_BLOCKS"], TRIGGER_MINIMUM_SECONDS: environment["TRIGGER_MINIMUM_SECONDS"],
});
