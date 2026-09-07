import { z } from "zod";
import { addressSchema, parseStrictJson } from "@aqua/core";

const authUriSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && url.hash === "";
}, "Expected an absolute, fragment-free HTTP(S) URI");
const pasetoPublicKeySchema = z.string().regex(/^k4\.public\.[A-Za-z0-9_-]{43}$/u);

const environmentSchema = z.object({
  CHAIN_ID: z.coerce.number().int().positive(),
  RPC_URL: z.url(),
  AQUA_ADDRESS: addressSchema,
  AQUA_SWAP_ROUTER_ADDRESS: addressSchema,
  LIMIT_SWAP_ROUTER_ADDRESS: addressSchema,
  WRAPPED_NATIVE_TOKEN_ADDRESS: addressSchema,
  ORDER_CONTROLLER_ADDRESS: addressSchema,
  DATABASE_URL: z.url(),
  SIWE_DOMAIN: z.string().min(1),
  SIWE_URI: z.url(),
  AUTH_ISSUER: authUriSchema,
  AUTH_RESOURCE: authUriSchema,
  PASETO_V4_SECRET_KEY: z.string().regex(/^k4\.secret\.[A-Za-z0-9_-]{86}$/u),
  PASETO_V4_PUBLIC_KEYS: z.array(pasetoPublicKeySchema).min(1).refine((keys) => new Set(keys).size === keys.length, "Duplicate PASETO public key"),
  ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TTL_SECONDS: z.coerce.number().int().min(300).default(2_592_000),
  RPC_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  ACTIVITY_CONFIRMATIONS: z.coerce.number().int().min(0).max(10_000),
  ACTIVITY_MAX_SUBSCRIPTIONS_PER_USER: z.coerce.number().int().min(1).max(10_000).default(100),
  INTENT_AUTHORIZATION_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
}).strict();

export type Configuration = z.infer<typeof environmentSchema>;

const parsePublicKeys = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try { return parseStrictJson(value); }
  catch { return value; }
};

export const loadConfiguration = (environment: Readonly<Record<string, string | undefined>>): Configuration => {
  const parsed = environmentSchema.parse({
    CHAIN_ID: environment["CHAIN_ID"], RPC_URL: environment["RPC_URL"],
    AQUA_ADDRESS: environment["AQUA_ADDRESS"], AQUA_SWAP_ROUTER_ADDRESS: environment["AQUA_SWAP_ROUTER_ADDRESS"],
    LIMIT_SWAP_ROUTER_ADDRESS: environment["LIMIT_SWAP_ROUTER_ADDRESS"], WRAPPED_NATIVE_TOKEN_ADDRESS: environment["WRAPPED_NATIVE_TOKEN_ADDRESS"],
    ORDER_CONTROLLER_ADDRESS: environment["ORDER_CONTROLLER_ADDRESS"],
    DATABASE_URL: environment["DATABASE_URL"],
    SIWE_DOMAIN: environment["SIWE_DOMAIN"], SIWE_URI: environment["SIWE_URI"],
    AUTH_ISSUER: environment["AUTH_ISSUER"], AUTH_RESOURCE: environment["AUTH_RESOURCE"],
    PASETO_V4_SECRET_KEY: environment["PASETO_V4_SECRET_KEY"],
    PASETO_V4_PUBLIC_KEYS: parsePublicKeys(environment["PASETO_V4_PUBLIC_KEYS"]),
    ACCESS_TTL_SECONDS: environment["ACCESS_TTL_SECONDS"], REFRESH_TTL_SECONDS: environment["REFRESH_TTL_SECONDS"],
    RPC_TIMEOUT_MS: environment["RPC_TIMEOUT_MS"], HOST: environment["HOST"], PORT: environment["PORT"],
    CORS_ORIGIN: environment["CORS_ORIGIN"],
    ACTIVITY_CONFIRMATIONS: environment["ACTIVITY_CONFIRMATIONS"],
    ACTIVITY_MAX_SUBSCRIPTIONS_PER_USER: environment["ACTIVITY_MAX_SUBSCRIPTIONS_PER_USER"],
    INTENT_AUTHORIZATION_TTL_SECONDS: environment["INTENT_AUTHORIZATION_TTL_SECONDS"],
  });
  return parsed;
};
