import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { hexToBytes, keccakHex } from "@aqua/evm";
import { z } from "zod";
import { hexSchema } from "@aqua/core";

const state = Bun.env["AQUA_STATE_DIR"];
const rpcUrl = Bun.env["AQUA_LOCAL_RPC_URL"];
const output = Bun.env["AQUA_E2E_REPORT"];
if (state === undefined || rpcUrl === undefined || output === undefined) throw new Error("Chain evidence environment is incomplete");

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);
const deployment = z.object({ address, transactionHash: hash.optional(), blockNumber: z.string(), installation: z.string() }).loose();
const deploymentsSchema = z.object({
  contracts: z.record(z.string(), deployment), tokens: z.array(deployment), seedTransactions: z.array(hash),
  seedOrders: z.array(z.object({ orderHash: hash, transactionHash: hash })),
}).loose();
const manifestSchema = z.object({ contracts: z.record(z.string(), z.object({ address, runtimeCodeHash: hash }).loose()) }).loose();
const deployments = deploymentsSchema.parse(await Bun.file(`${state}/deployments.json`).json());
const manifest = manifestSchema.parse(await Bun.file(`${state}/runtime-manifest.json`).json());

let rpcId = 0;
const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
  const id = ++rpcId;
  const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const body = z.object({ result: z.unknown().optional(), error: z.unknown().optional() }).loose().parse(await response.json());
  if (!response.ok || body.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
};
const allDeployments = [...Object.entries(deployments.contracts), ...deployments.tokens.map((item, index) => [`token${String(index)}`, item] as const)];
const contracts: Record<string, unknown> = {};
for (const [name, item] of allDeployments) {
  const code = hexSchema.parse(await rpc("eth_getCode", [item.address, "latest"]));
  if (code === "0x") throw new Error(`${name} has no runtime code at ${item.address}`);
  const codeHash = keccakHex(hexToBytes(code));
  let creation: unknown = null;
  if (item.transactionHash !== undefined) {
    const transaction = z.object({ to: z.union([address, z.null()]) }).loose().parse(await rpc("eth_getTransactionByHash", [item.transactionHash]));
    const receipt = z.object({ status: z.string(), contractAddress: z.union([address, z.null()]).optional() }).loose().parse(await rpc("eth_getTransactionReceipt", [item.transactionHash]));
    if (receipt.status !== "0x1") throw new Error(`${name} deployment reverted`);
    if (item.installation === "create" && transaction.to !== null) throw new Error(`${name} was not deployed by contract creation`);
    creation = { transactionHash: item.transactionHash, transactionTo: transaction.to, receiptContract: receipt.contractAddress ?? null };
  }
  const expected = manifest.contracts[name]?.runtimeCodeHash;
  if (expected !== undefined) {
    const manifestEntry = manifest.contracts[name];
    if (manifestEntry?.address.toLowerCase() !== item.address.toLowerCase()) throw new Error(`${name} manifest address drifted`);
    if (expected.toLowerCase() !== codeHash.toLowerCase()) throw new Error(`${name} manifest code hash does not match eth_getCode`);
  }
  contracts[name] = { address: item.address, byteLength: (code.length - 2) / 2, runtimeCodeHash: codeHash, manifestRuntimeCodeHash: expected ?? null, creation };
}

const aqua = deployments.contracts["aqua"];
if (aqua === undefined) throw new Error("Aqua deployment is missing");
const seedTraces: unknown[] = [];
for (const order of deployments.seedOrders) {
  const traces = z.array(z.object({ action: z.object({ to: address.optional() }).loose() }).loose()).parse(await rpc("trace_transaction", [order.transactionHash]));
  if (!traces.some((trace) => trace.action.to?.toLowerCase() === aqua.address.toLowerCase())) throw new Error(`Seed order ${order.orderHash} did not call the deployed Aqua contract`);
  seedTraces.push({ ...order, aquaHit: true, traceCount: traces.length });
}

await mkdir(dirname(output), { recursive: true });
await Bun.write(output, `${JSON.stringify({ createdAt: new Date().toISOString(), chainId: await rpc("eth_chainId", []), contracts, seedTraces }, null, 2)}\n`);
console.log(`Verified ${String(allDeployments.length)} live deployments and ${String(seedTraces.length)} Aqua call traces`);
