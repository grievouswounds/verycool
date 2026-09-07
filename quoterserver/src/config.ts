import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  oneInchApiKey: requireEnv("ONEINCH_API_KEY"),
  oneInchBaseUrl: process.env.ONEINCH_BASE_URL ?? "https://api.1inch.com",
  // Currency prices are quoted in (e.g. USD). 1inch also supports raw wei
  // native-token pricing if this is omitted, but USD is more useful for most apps.
  defaultCurrency: process.env.DEFAULT_CURRENCY ?? "USD",
};

/** Runtime credentials required only when broadcasting an Aqua trade. */
export function getTradeConfig() {
  return {
    rpcUrl: getRpcUrl(),
    privateKey: requireEnv("WALLET_PRIVATE_KEY") as `0x${string}`,
  };
}

/** An RPC endpoint is enough for read-only Aqua quote simulations. */
export function getRpcUrl(): string {
  return requireEnv("RPC_URL");
}
