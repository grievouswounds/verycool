import { AquaProtocolGateway, AuthService, PostgresActivityRepository, PostgresAuthStore, PostgresTradingRepository, createDatabase, closeDatabase } from "@aqua/adapters";
import { ActivityService, RpcActivityChain } from "@aqua/activity";
import { ProtocolService } from "@aqua/contracts";
import { initializeCubane, JsonRpcClient } from "@aqua/evm";
import { IntentAuthorizationService, TradingService } from "@aqua/orderbook";
import { createServerOptions } from "./server.ts";
import { loadConfiguration } from "./config.ts";

const config = loadConfiguration(Bun.env);
initializeCubane();
const rpc = new JsonRpcClient(new URL(config.RPC_URL), config.RPC_TIMEOUT_MS);
const database = createDatabase(config.DATABASE_URL);
await database.connect();
const store = new PostgresAuthStore(database);
await store.initialize();
const auth = await AuthService.create({
  domain: config.SIWE_DOMAIN, uri: config.SIWE_URI, chainId: config.CHAIN_ID,
  issuer: config.AUTH_ISSUER, resource: config.AUTH_RESOURCE,
  secretKeyPaserk: config.PASETO_V4_SECRET_KEY, publicKeysPaserk: config.PASETO_V4_PUBLIC_KEYS,
  accessTtlSeconds: config.ACCESS_TTL_SECONDS, refreshTtlSeconds: config.REFRESH_TTL_SECONDS,
}, store, rpc);
const protocol = new ProtocolService({
  chainId: config.CHAIN_ID, aqua: config.AQUA_ADDRESS,
  aquaSwapRouter: config.AQUA_SWAP_ROUTER_ADDRESS,
  limitSwapRouter: config.LIMIT_SWAP_ROUTER_ADDRESS,
  wrappedNativeToken: config.WRAPPED_NATIVE_TOKEN_ADDRESS,
}, rpc);
const activityRepository = new PostgresActivityRepository(database);
await activityRepository.initialize();
const activity = new ActivityService(
  activityRepository, new RpcActivityChain(rpc), BigInt(config.ACTIVITY_CONFIRMATIONS),
  config.ACTIVITY_MAX_SUBSCRIPTIONS_PER_USER,
);
const tradingRepository = new PostgresTradingRepository(database);
await tradingRepository.initialize();
const trading = new TradingService(
  tradingRepository, new AquaProtocolGateway(protocol, rpc),
  new IntentAuthorizationService(tradingRepository, rpc, {
    chainId: config.CHAIN_ID, controller: config.ORDER_CONTROLLER_ADDRESS,
    validitySeconds: config.INTENT_AUTHORIZATION_TTL_SECONDS,
  }),
  config.CHAIN_ID,
);

const configuredContracts = [config.AQUA_ADDRESS, config.AQUA_SWAP_ROUTER_ADDRESS, config.LIMIT_SWAP_ROUTER_ADDRESS, config.WRAPPED_NATIVE_TOKEN_ADDRESS, config.ORDER_CONTROLLER_ADDRESS];
const readiness = async (): Promise<boolean> => {
  if (await rpc.chainId() !== config.CHAIN_ID) return false;
  const codes = await Promise.all(configuredContracts.map((address) => rpc.getCode(address)));
  return codes.every((code) => code.length > 2);
};
if (!(await readiness())) throw new Error("Startup validation failed: chain or configured contract mismatch");

const serverOptions = createServerOptions({ trading, auth, activity, corsOrigin: config.CORS_ORIGIN, readiness });
Object.assign(serverOptions, { hostname: config.HOST, port: config.PORT });
const server = Bun.serve(serverOptions);
console.log(JSON.stringify({ level: "info", message: "server started", url: server.url.toString(), chainId: config.CHAIN_ID }));

const shutdown = async (): Promise<void> => {
  await server.stop();
  await closeDatabase(database);
};
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
