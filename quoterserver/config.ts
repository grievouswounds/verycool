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
