import { describe, expect, test } from "bun:test";
import { generateKeys } from "paseto-ts/v4";
import { loadConfiguration } from "../src/config.ts";

const pair = generateKeys("public");
const validEnvironment = (): Readonly<Record<string, string>> => ({
  CHAIN_ID: "1", RPC_URL: "http://localhost:8545",
  AQUA_ADDRESS: "0x0000000000000000000000000000000000000001",
  AQUA_SWAP_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000002",
  LIMIT_SWAP_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000003",
  WRAPPED_NATIVE_TOKEN_ADDRESS: "0x0000000000000000000000000000000000000004",
  ORDER_CONTROLLER_ADDRESS: "0x0000000000000000000000000000000000000005",
  DATABASE_URL: "postgresql://aqua:aqua@localhost:5432/aqua",
  SIWE_DOMAIN: "localhost", SIWE_URI: "http://localhost:3000",
  AUTH_ISSUER: "https://auth.example.com", AUTH_RESOURCE: "https://api.example.com/mcp",
  PASETO_V4_SECRET_KEY: pair.secretKey, PASETO_V4_PUBLIC_KEYS: JSON.stringify([pair.publicKey]),
  ACTIVITY_CONFIRMATIONS: "2",
});

describe("PASETO configuration", () => {
  test("parses PASERK keys and canonical auth URIs", () => {
    const config = loadConfiguration(validEnvironment());
    expect(config.PASETO_V4_PUBLIC_KEYS).toEqual([pair.publicKey]);
    expect(config.AUTH_RESOURCE).toBe("https://api.example.com/mcp");
  });

  test("rejects malformed, duplicate, and legacy-only key configuration", () => {
    expect(() => loadConfiguration({ ...validEnvironment(), PASETO_V4_PUBLIC_KEYS: "not-json" })).toThrow();
    expect(() => loadConfiguration({ ...validEnvironment(), PASETO_V4_PUBLIC_KEYS: JSON.stringify([pair.publicKey, pair.publicKey]) })).toThrow();
    const legacy = Object.fromEntries(Object.entries(validEnvironment()).filter(([key]) => !key.startsWith("PASETO_")));
    expect(() => loadConfiguration({ ...legacy, JWT_PRIVATE_KEY_PEM: "old", JWT_PUBLIC_KEY_PEM: "old" })).toThrow();
  });
});
