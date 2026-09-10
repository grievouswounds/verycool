import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { addressSchema, hashSchema } from "@aqua/core";
import type { Hash } from "@aqua/core";
import { encodeBalanceOf, keccakHex } from "@aqua/evm";
import { z } from "zod";

const output = Bun.env["AQUA_E2E_REPORT"];
const rpcUrl = Bun.env["AQUA_LOCAL_RPC_URL"] ?? Bun.env["AQUA_RPC_URL"];
const mcpPath = Bun.env["AQUA_MCP_REPORT"] ?? `${new URL("../../reports/e2e/mcp.json", import.meta.url).pathname}`;
const ownerEvidence = Bun.env["AQUA_LEDGER_OWNER_EVIDENCE"];
const manifestPath = Bun.env["AQUA_RUNTIME_MANIFEST"];
if (output === undefined || rpcUrl === undefined || ownerEvidence === undefined || manifestPath === undefined) {
  throw new Error("Trade evidence environment is incomplete");
}

const topic = (signature: string) => keccakHex(new TextEncoder().encode(signature));
const topics = {
  actionExecuted: topic("ActionExecuted(address,uint8,bytes32)"),
  swapExecuted: topic("SwapExecuted(address,address,uint256,uint256)"),
  activated: topic("Activated(bytes32,uint256)"),
  cancelled: topic("Cancelled(bytes32)"),
  triggerActivated: topic("TriggerActivated(bytes32,bytes32)"),
  withdrawn: topic("Withdrawn(address,address,uint256)"),
};

let rpcId = 0;
const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
  const id = ++rpcId;
  const response = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = z.object({ result: z.unknown().optional(), error: z.unknown().optional() }).loose().parse(await response.json());
  if (body.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
};

const receiptSchema = z.object({
  status: z.string(), logs: z.array(z.object({ topics: z.array(hashSchema), address: addressSchema }).loose()),
}).loose();
const mcpSchema = z.object({
  scenarios: z.array(z.object({
    name: z.string(), tradeId: z.uuid().optional(), status: z.string().optional(),
    tradeTransactionHash: hashSchema.nullable().optional(),
    fundingTransactionHash: hashSchema.nullable().optional(),
    cancellationTransactionHash: hashSchema.optional(),
    rejected: z.boolean().optional(),
    disposition: z.string().optional(),
    matchingOutcome: z.string().nullable().optional(),
  }).loose()),
  owner: addressSchema.optional(),
}).loose();

const mcp = mcpSchema.parse(JSON.parse(await readFile(mcpPath, "utf8")));
const owner = z.object({ owner: addressSchema }).loose().parse(JSON.parse(await readFile(ownerEvidence, "utf8"))).owner;
const manifest = z.object({
  fixtures: z.object({ tokens: z.array(z.object({ address: addressSchema }).loose()).min(1) }).loose(),
}).loose().parse(JSON.parse(await readFile(manifestPath, "utf8")));
const sellToken = manifest.fixtures.tokens[0]?.address;
if (sellToken === undefined) throw new Error("Fixture sell token is missing");

const required = [
  "marketIocSellFirst", "marketIocSellSecond", "crossingLimit", "restingLimit", "cancelResting",
  "fokThinBook", "stopLossArmed", "cancelArmedStop", "stopLossFired", "takeProfitFired", "oco",
];
for (const name of required) {
  if (!mcp.scenarios.some((item) => item.name === name)) throw new Error(`Missing scenario ${name}`);
}

const decoded: Record<string, unknown>[] = [];
for (const scenario of mcp.scenarios) {
  const hashes = [scenario.tradeTransactionHash, scenario.fundingTransactionHash, scenario.cancellationTransactionHash]
    .filter((value): value is Hash => typeof value === "string");
  const events: string[] = [];
  for (const hash of hashes) {
    const receipt = receiptSchema.parse(await rpc("eth_getTransactionReceipt", [hash]));
    if (receipt.status !== "0x1") throw new Error(`${scenario.name} transaction ${hash} reverted`);
    for (const log of receipt.logs) {
      const signature = log.topics[0];
      if (signature === topics.actionExecuted) events.push("ActionExecuted");
      if (signature === topics.swapExecuted) events.push("SwapExecuted");
      if (signature === topics.activated) events.push("Activated");
      if (signature === topics.cancelled) events.push("Cancelled");
      if (signature === topics.triggerActivated) events.push("TriggerActivated");
      if (signature === topics.withdrawn) events.push("Withdrawn");
    }
  }
  if (scenario.name === "marketIocSellFirst" || scenario.name === "marketIocSellSecond" || scenario.name === "crossingLimit") {
    if (!events.includes("ActionExecuted") || !events.includes("SwapExecuted")) {
      throw new Error(`${scenario.name} did not emit ActionExecuted and SwapExecuted`);
    }
  }
  if (scenario.name === "restingLimit" && !events.includes("Activated") && !events.includes("ActionExecuted")) {
    throw new Error("Resting limit did not activate on-chain");
  }
  if (scenario.name === "cancelResting" && !events.includes("Cancelled") && !events.includes("ActionExecuted")) {
    throw new Error("Resting cancellation did not emit Cancelled");
  }
  if (scenario.name === "cancelArmedStop" && !events.includes("Withdrawn") && !events.includes("ActionExecuted")) {
    throw new Error("Armed stop cancellation did not return funds");
  }
  if (scenario.name === "fokThinBook" && scenario.rejected !== true) throw new Error("FOK scenario was not rejected");
  if (scenario.name === "stopLossFired" || scenario.name === "takeProfitFired" || scenario.name === "oco") {
    if (!events.includes("ActionExecuted") && !events.includes("TriggerActivated") && !events.includes("SwapExecuted")) {
      throw new Error(`${scenario.name} did not execute on-chain after the trigger window`);
    }
  }
  decoded.push({ name: scenario.name, tradeId: scenario.tradeId ?? null, status: scenario.status ?? null, events, hashes });
}

const balanceData = z.string().parse(await rpc("eth_call", [{ to: sellToken, data: encodeBalanceOf(owner) }, "latest"]));
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, `${JSON.stringify({
  owner, sellToken, ownerSellBalance: BigInt(balanceData).toString(), scenarios: decoded,
}, null, 2)}\n`);
console.log(`Verified on-chain evidence for ${String(decoded.length)} trade scenarios`);
