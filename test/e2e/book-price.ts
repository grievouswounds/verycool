import { readFile } from "node:fs/promises";
import { addressSchema, hashSchema, hexSchema, limitOrderRequestSchema } from "@aqua/core";
import { ProtocolService } from "@aqua/contracts";
import { JsonRpcClient } from "@aqua/evm";
import { z } from "zod";

const FIXTURE_MAKER = addressSchema.parse("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const rpcUrl = Bun.env["AQUA_LOCAL_RPC_URL"] ?? Bun.env["AQUA_RPC_URL"];
const stateDir = Bun.env["AQUA_STATE_DIR"];
const manifestPath = Bun.env["AQUA_RUNTIME_MANIFEST"];
if (rpcUrl === undefined || stateDir === undefined || manifestPath === undefined) throw new Error("Book-price environment is incomplete");

const rpc = new JsonRpcClient(new URL(rpcUrl), 10_000);
let rpcId = 0;
const rpcRequest = async (method: string, params: readonly unknown[]): Promise<unknown> => {
  const id = ++rpcId;
  const response = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = z.object({ result: z.unknown().optional(), error: z.unknown().optional() }).loose().parse(await response.json());
  if (body.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
};

const manifest = z.object({
  chain: z.object({ id: z.number() }).loose(),
  contracts: z.object({
    aqua: z.object({ address: addressSchema }).loose(),
    aquaSwapRouter: z.object({ address: addressSchema }).loose(),
    limitSwapRouter: z.object({ address: addressSchema }).loose(),
    wrappedNativeToken: z.object({ address: addressSchema }).loose(),
  }).loose(),
  fixtures: z.object({ tokens: z.array(z.object({ address: addressSchema }).loose()).min(2) }).loose(),
}).loose().parse(JSON.parse(await readFile(manifestPath, "utf8")));
const deployments = z.object({
  seedOrders: z.array(z.object({ orderHash: hashSchema }).loose()),
}).loose().parse(JSON.parse(await readFile(`${stateDir}/deployments.json`, "utf8")));

const protocol = new ProtocolService({
  chainId: manifest.chain.id, aqua: manifest.contracts.aqua.address, aquaSwapRouter: manifest.contracts.aquaSwapRouter.address,
  limitSwapRouter: manifest.contracts.limitSwapRouter.address, wrappedNativeToken: manifest.contracts.wrappedNativeToken.address,
}, rpc);
const principal = { address: FIXTURE_MAKER, scopes: new Set(["trading:read" as const, "trading:write" as const]), sessionId: "e2e-book" };

const send = async (to: string, data: string): Promise<string> => {
  const hash = hashSchema.parse(await rpcRequest("eth_sendTransaction", [{ from: FIXTURE_MAKER, to, data }]));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const receipt = z.object({ status: z.string().optional() }).loose().nullable()
      .parse(await rpcRequest("eth_getTransactionReceipt", [hash]));
    if (receipt?.status === "0x1") return hash;
    if (receipt?.status === "0x0") throw new Error(`Fixture maker transaction reverted: ${hash}`);
    await Bun.sleep(150);
  }
  throw new Error(`Fixture maker transaction was not mined: ${hash}`);
};

export const firstToken = manifest.fixtures.tokens[0]?.address;
export const secondToken = manifest.fixtures.tokens[1]?.address;
if (firstToken === undefined || secondToken === undefined) throw new Error("Two fixture tokens are required");
export const seedOrderHashes = deployments.seedOrders.map((item) => item.orderHash);

export const shipLimit = async (input: { readonly sellToken: string; readonly buyToken: string; readonly sellAmount: string; readonly buyAmount: string }): Promise<string> => {
  const prepared = await protocol.prepareLimit(limitOrderRequestSchema.parse({
    ...input, timeInForce: "GTC", fillPolicy: "partial",
  }), principal);
  if (prepared.approval !== undefined) await send(prepared.approval.to, prepared.approval.data);
  return send(prepared.shipTransaction.to, prepared.shipTransaction.data);
};

export const dockOrder = async (orderHash: string, sellToken: string, buyToken: string): Promise<string> => {
  const prepared = protocol.prepareLimitCancellation({
    orderHash: hashSchema.parse(orderHash), sellToken: addressSchema.parse(sellToken), buyToken: addressSchema.parse(buyToken),
  }, principal);
  return send(prepared.transaction.to, hexSchema.parse(prepared.transaction.data));
};

export const mine = async (blocks = 2, extraSeconds = 2): Promise<void> => {
  const latest = z.object({ timestamp: hexSchema }).loose().parse(await rpcRequest("eth_getBlockByNumber", ["latest", false]));
  let timestamp = Number(BigInt(latest.timestamp));
  for (let index = 0; index < blocks; index += 1) {
    timestamp += extraSeconds;
    await rpcRequest("evm_setNextBlockTimestamp", [`0x${timestamp.toString(16)}`]);
    await rpcRequest("anvil_mine", ["0x1"]);
  }
};

/** Lower the aUSD/aETH best bid so a sell stop at `0.0008` can persist and fire. */
export const lowerUsdEthBid = async (): Promise<void> => {
  const buy = seedOrderHashes[1];
  if (buy !== undefined) await dockOrder(buy, secondToken, firstToken);
  await shipLimit({ sellToken: secondToken, buyToken: firstToken, sellAmount: "1", buyAmount: "1255" });
  await mine(2, 2);
};

/** Raise the aUSD/aETH best bid so a sell take-profit at `0.002` can persist and fire. */
export const raiseUsdEthBid = async (): Promise<void> => {
  await shipLimit({ sellToken: secondToken, buyToken: firstToken, sellAmount: "3", buyAmount: "1000" });
  await mine(2, 2);
};

export const waitForWorker = async (): Promise<void> => {
  await mine(2, 2);
  await Bun.sleep(8_000);
};
