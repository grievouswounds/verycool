import { describe, expect, test } from "bun:test";
import { loadOrderWorkerConfiguration } from "../src/config.ts";

const environment = {
  RPC_URL: "http://localhost:8545", DATABASE_URL: "postgresql://aqua:aqua@localhost:5432/aqua",
  CHAIN_ID: "1", LIMIT_SWAP_ROUTER_ADDRESS: "0x2222222222222222222222222222222222222222",
  ORDER_CONTROLLER_ADDRESS: "0x5555555555555555555555555555555555555555",
  ORDERBOOK_PAIRS: "[{\"baseToken\":\"0x3333333333333333333333333333333333333333\",\"quoteToken\":\"0x4444444444444444444444444444444444444444\"}]",
  ORDERBOOK_CONTRACTS: "[\"0x1111111111111111111111111111111111111111\"]",
  ORDERBOOK_START_BLOCK: "0", ORDERBOOK_CONFIRMATIONS: "2", UNRELATED_PROCESS_VALUE: "ignored",
  KEEPER_PRIVATE_KEY_FILE: "/run/secrets/keeper-key", KEEPER_ALLOWED_TARGETS: "[\"0x5555555555555555555555555555555555555555\"]",
  KEEPER_ALLOWED_SELECTORS: "[\"0x12345678\"]", KEEPER_GAS_LIMIT: "1000000", KEEPER_MAX_FEE_GWEI: "100",
};

describe("order worker configuration grammar", () => {
  test("accepts bounded allowlisted contracts and ignores unrelated process variables", () => {
    expect(loadOrderWorkerConfiguration(environment).ORDERBOOK_POLL_INTERVAL_SECONDS).toBe(2);
  });

  test("rejects duplicate addresses and noncanonical integers", () => {
    expect(() => loadOrderWorkerConfiguration({ ...environment, ORDERBOOK_CONTRACTS: "[\"0x1111111111111111111111111111111111111111\",\"0x1111111111111111111111111111111111111111\"]" })).toThrow();
    expect(() => loadOrderWorkerConfiguration({ ...environment, ORDERBOOK_START_BLOCK: "00" })).toThrow();
  });
});
