import { randomUUID } from "node:crypto";
import { ActivityCollector, RpcActivityChain } from "@aqua/activity";
import { PostgresActivityRepository, createDatabase, closeDatabase } from "@aqua/adapters";
import { loadRuntimeManifest, localProfileDefaults, runtimeManifestHash } from "@aqua/core";
import { initializeCubane, JsonRpcClient } from "@aqua/evm";

const manifest=await loadRuntimeManifest(Bun.argv);const defaults=localProfileDefaults;
initializeCubane();
const database=createDatabase(manifest.services.databaseUrl);await database.connect();
const repository=new PostgresActivityRepository(database);await repository.initialize();
const collector=new ActivityCollector(repository,new RpcActivityChain(new JsonRpcClient(new URL(manifest.chain.rpcUrl),defaults.rpcTimeoutMs)),{confirmations:BigInt(manifest.indexer.confirmations),blockChunkSize:BigInt(defaults.activityBlockChunkSize),subscriptionBatchSize:defaults.activityScanConcurrency});
console.log(JSON.stringify({level:"info",component:"activity-worker",manifestHash:runtimeManifestHash(manifest)}));
const holder=randomUUID();let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;
const tick=async():Promise<void>=>{const now=new Date();const until=new Date(now.getTime()+defaults.activityWorkerLeaseSeconds*1_000);if(await repository.acquireLease("erc20-activity",holder,now,until))await collector.runOnce();};
const schedule=():void=>{if(stopped)return;const interval=defaults.activityPollIntervalSeconds*1_000;timer=setTimeout(()=>{void tick().catch((error:unknown)=>{console.error(JSON.stringify({level:"error",component:"activity-worker",message:error instanceof Error?error.message:"Unknown worker error"}));}).finally(schedule);},interval-Date.now()%interval);};
await tick();schedule();
const shutdown=async():Promise<void>=>{stopped=true;if(timer!==undefined)clearTimeout(timer);await closeDatabase(database);};
process.once("SIGTERM",()=>{void shutdown();});process.once("SIGINT",()=>{void shutdown();});
