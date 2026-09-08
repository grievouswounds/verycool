import { AquaProtocolGateway, AuthService, LedgerWebAuthnService, OAuthService, PostgresActivityRepository, PostgresAuthStore, PostgresLedgerWebAuthnStore, PostgresTradingRepository, createDatabase, closeDatabase } from "@aqua/adapters";
import { ActivityService, RpcActivityChain } from "@aqua/activity";
import { loadRuntimeManifest, localProfileDefaults, runtimeManifestHash } from "@aqua/core";
import { ProtocolService } from "@aqua/contracts";
import { initializeCubane, JsonRpcClient, hexToBytes, keccakHex } from "@aqua/evm";
import { IntentAuthorizationService, TradingService } from "@aqua/orderbook";
import { SecretBrokerClient } from "@aqua/security";
import { currencySchema, OneInchPriceClient, QuoterService } from "@aqua/quoter";
import { createServerOptions } from "./server.ts";

const manifest=await loadRuntimeManifest(Bun.argv);
const defaults=localProfileDefaults;
initializeCubane();
const rpc=new JsonRpcClient(new URL(manifest.chain.rpcUrl),defaults.rpcTimeoutMs);
const database=createDatabase(manifest.services.databaseUrl);
await database.connect();
const authStore=new PostgresAuthStore(database);
await authStore.initialize();
const broker=new SecretBrokerClient(manifest.services.brokerSocket);
const identity=await broker.identity();
if(identity.pasetoPublicKey!==manifest.auth.pasetoPublicKeys[0]) throw new Error("Secret broker identity does not match runtime manifest");
const auth=AuthService.withIssuer({
  domain:manifest.auth.rpId,uri:manifest.auth.origin,chainId:manifest.chain.id,
  issuer:manifest.auth.issuer,resource:manifest.auth.resource,secretKeyPaserk:"broker://paseto",
  publicKeysPaserk:manifest.auth.pasetoPublicKeys,accessTtlSeconds:defaults.accessTtlSeconds,
  refreshTtlSeconds:defaults.refreshTtlSeconds,
},authStore,rpc,{issue:(grant)=>broker.issuePaseto({address:grant.address,sessionId:grant.sessionId,scopes:grant.scopes,amr:grant.amr??["siwe"],clientId:grant.clientId??"aqua-rest"})});
const webauthn=new LedgerWebAuthnService(new PostgresLedgerWebAuthnStore(database),manifest.auth.rpId,manifest.auth.origin);
const oauth=new OAuthService(database,manifest.auth.resource,(grant)=>broker.issuePaseto({address:grant.owner,sessionId:crypto.randomUUID(),scopes:grant.scopes,amr:["fido2","hwk"],clientId:grant.clientId}));
const protocol=new ProtocolService({
  chainId:manifest.chain.id,aqua:manifest.contracts.aqua.address,
  aquaSwapRouter:manifest.contracts.aquaSwapRouter.address,
  limitSwapRouter:manifest.contracts.limitSwapRouter.address,
  wrappedNativeToken:manifest.contracts.wrappedNativeToken.address,
},rpc);
const oneInchApiKey=Bun.env["ONEINCH_API_KEY"]?.trim();
const oneInchBaseUrl=new URL(Bun.env["ONEINCH_BASE_URL"]??"https://api.1inch.com");
const oneInchDefaultCurrency=currencySchema.parse(Bun.env["ONEINCH_DEFAULT_CURRENCY"]??"USD");
const quoter=new QuoterService({chainId:manifest.chain.id,defaultCurrency:oneInchDefaultCurrency,protocol,priceClient:oneInchApiKey===undefined||oneInchApiKey.length===0?null:new OneInchPriceClient({apiKey:oneInchApiKey,baseUrl:oneInchBaseUrl})});
const activityRepository=new PostgresActivityRepository(database);
await activityRepository.initialize();
const activity=new ActivityService(activityRepository,new RpcActivityChain(rpc),BigInt(manifest.indexer.confirmations),defaults.activityMaxSubscriptionsPerUser);
const tradingRepository=new PostgresTradingRepository(database);
await tradingRepository.initialize();
const trading=new TradingService(tradingRepository,new AquaProtocolGateway(protocol,rpc),new IntentAuthorizationService(tradingRepository,rpc,{chainId:manifest.chain.id,controller:manifest.contracts.intentController.address,validitySeconds:defaults.intentAuthorizationTtlSeconds}),manifest.chain.id);

const readiness=async():Promise<boolean>=>{
  if(await rpc.chainId()!==manifest.chain.id)return false;
  const genesis=await rpc.block(0n);
  if(genesis.hash!==manifest.chain.genesisHash)return false;
  for(const expected of Object.values(manifest.contracts)){
    const code=await rpc.getCode(expected.address);
    if(code==="0x"||keccakHex(hexToBytes(code))!==expected.runtimeCodeHash)return false;
  }
  await broker.identity();
  return true;
};
if(!await readiness())throw new Error("Startup validation failed: stale or inconsistent runtime manifest");
const apiUrl=new URL(manifest.services.apiUrl);
const options=createServerOptions({trading,auth,activity,webauthn,oauth,quoter,manifest,corsOrigin:manifest.auth.origin,readiness,issuer:manifest.auth.issuer,resource:manifest.auth.resource});
Object.assign(options,{hostname:"127.0.0.1",port:Number(apiUrl.port)});
const server=Bun.serve(options);
console.log(JSON.stringify({level:"info",message:"server started",url:server.url.toString(),chainId:manifest.chain.id,manifestHash:runtimeManifestHash(manifest)}));
const shutdown=async():Promise<void>=>{await server.stop();await closeDatabase(database);};
process.once("SIGTERM",()=>{void shutdown();});
process.once("SIGINT",()=>{void shutdown();});
