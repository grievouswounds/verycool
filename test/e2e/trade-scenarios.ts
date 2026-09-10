import { addressSchema, hashSchema } from "@aqua/core";
import { z } from "zod";
import { firstToken, secondToken, lowerUsdEthBid, raiseUsdEthBid, waitForWorker, mine } from "./book-price.ts";

export interface McpCall {
  (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const previewSchema = z.object({
  previewId: z.uuid(), previewHash: hashSchema, disposition: z.enum(["immediate", "resting", "conditional"]),
  matching: z.object({ outcome: z.enum(["fillsNow", "rests", "unfillable"]) }).loose().nullable(),
  execution: z.object({ vault: addressSchema, kind: z.enum(["market", "resting", "armed"]) }).loose(),
  safety: z.object({ safe: z.boolean(), verdict: z.enum(["benign", "warning", "malicious"]) }).loose(),
}).loose();
const submissionSchema = z.object({
  tradeId: z.uuid(), status: z.string(),
  tradeTransactionHash: hashSchema.nullable(),
  fundingTransactionHash: hashSchema.nullable(),
}).loose();
const cancellationSchema = z.object({ tradeId: z.uuid(), status: z.literal("cancelled"), transactionHash: hashSchema }).loose();
const tradesSchema = z.object({
  items: z.array(z.object({
    id: z.uuid(), status: z.string(), kind: z.string().nullable(),
    lifecycleTransactionHash: hashSchema.nullable().optional(),
    paymentTransactionHash: hashSchema.nullable().optional(),
  }).loose()),
}).loose();

export interface ScenarioRecord {
  readonly name: string;
  readonly tradeId?: string;
  readonly previewId?: string;
  readonly disposition?: string;
  readonly matchingOutcome?: string | null;
  readonly status?: string;
  readonly tradeTransactionHash?: string | null;
  readonly fundingTransactionHash?: string | null;
  readonly cancellationTransactionHash?: string;
  readonly rejected?: boolean;
}

const market = (sell: string, buy: string, timeInForce: "ioc" | "fok" = "ioc", amount = "1") => ({
  sellToken: { type: "address" as const, address: sell }, buyToken: { type: "address" as const, address: buy },
  amount: { side: "sell" as const, value: amount }, policy: { kind: "market" as const, slippageBps: "50", timeInForce },
});

const post = async (call: McpCall, request: Record<string, unknown>, expected: { disposition: "immediate" | "resting" | "conditional"; matching?: "fillsNow" | "rests" }): Promise<{ preview: z.infer<typeof previewSchema>; submitted: z.infer<typeof submissionSchema> }> => {
  const preview = previewSchema.parse(await call("request_trade", request));
  if (preview.disposition !== expected.disposition) throw new Error(`Expected ${expected.disposition}, got ${preview.disposition}`);
  if (expected.matching !== undefined && preview.matching?.outcome !== expected.matching) {
    throw new Error(`Expected matching ${expected.matching}, got ${preview.matching?.outcome ?? "null"}`);
  }
  if (preview.safety.safe !== true) throw new Error(`Preview is not safe: ${preview.safety.verdict}`);
  const submitted = submissionSchema.parse(await call("post_trade", { previewId: preview.previewId, previewHash: preview.previewHash }));
  return { preview, submitted };
};

const waitStatus = async (call: McpCall, tradeId: string, allowed: readonly string[]): Promise<{
  readonly status: string; readonly lifecycleTransactionHash: string | null;
}> => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const listed = tradesSchema.parse(await call("get_trades", { source: "own", sort: "updatedAt", direction: "desc", limit: "50" }));
    const row = listed.items.find((item) => item.id === tradeId);
    if (row !== undefined && allowed.includes(row.status)) {
      return { status: row.status, lifecycleTransactionHash: row.lifecycleTransactionHash ?? null };
    }
    await mine(1, 1);
    await Bun.sleep(1_000);
  }
  throw new Error(`Trade ${tradeId} did not reach ${allowed.join("|")}`);
};

export const runTradeScenarios = async (call: McpCall): Promise<readonly ScenarioRecord[]> => {
  if (firstToken === undefined || secondToken === undefined) throw new Error("Fixture tokens are required");
  const records: ScenarioRecord[] = [];

  for (const [name, sell, buy, amount] of [
    ["marketIocSellFirst", firstToken, secondToken, "1"],
    ["marketIocSellSecond", secondToken, firstToken, "0.01"],
  ] as const) {
    const { preview, submitted } = await post(call, market(sell, buy, "ioc", amount), { disposition: "immediate", matching: "fillsNow" });
    records.push({
      name, tradeId: submitted.tradeId, previewId: preview.previewId, disposition: preview.disposition,
      matchingOutcome: preview.matching?.outcome ?? null, status: submitted.status,
      tradeTransactionHash: submitted.tradeTransactionHash, fundingTransactionHash: submitted.fundingTransactionHash,
    });
  }

  const crossing = await post(call, {
    sellToken: { type: "address", address: firstToken }, buyToken: { type: "address", address: secondToken },
    amount: { side: "sell", value: "1" },
    policy: { kind: "limit", limitPrice: "0.0005", timeInForce: { kind: "gtc" }, fillPolicy: "partial", postPolicy: "normal" },
  }, { disposition: "immediate", matching: "fillsNow" });
  records.push({
    name: "crossingLimit", tradeId: crossing.submitted.tradeId, previewId: crossing.preview.previewId,
    disposition: crossing.preview.disposition, matchingOutcome: crossing.preview.matching?.outcome ?? null,
    status: crossing.submitted.status, tradeTransactionHash: crossing.submitted.tradeTransactionHash,
    fundingTransactionHash: crossing.submitted.fundingTransactionHash,
  });

  const resting = await post(call, {
    sellToken: { type: "address", address: firstToken }, buyToken: { type: "address", address: secondToken },
    amount: { side: "sell", value: "1" },
    policy: { kind: "limit", limitPrice: "0.002", timeInForce: { kind: "gtc" }, fillPolicy: "partial", postPolicy: "normal" },
  }, { disposition: "resting", matching: "rests" });
  records.push({
    name: "restingLimit", tradeId: resting.submitted.tradeId, previewId: resting.preview.previewId,
    disposition: resting.preview.disposition, matchingOutcome: resting.preview.matching?.outcome ?? null,
    status: resting.submitted.status, tradeTransactionHash: resting.submitted.tradeTransactionHash,
    fundingTransactionHash: resting.submitted.fundingTransactionHash,
  });
  const restingLive = resting.submitted.status === "broadcast"
    ? { status: resting.submitted.status, lifecycleTransactionHash: resting.submitted.tradeTransactionHash }
    : await waitStatus(call, resting.submitted.tradeId, ["broadcast"]);
  if (restingLive.lifecycleTransactionHash === null) throw new Error("Resting limit did not broadcast a vault action");
  const cancelledResting = cancellationSchema.parse(await call("cancel_trade", { tradeId: resting.submitted.tradeId }));
  records.push({
    name: "cancelResting", tradeId: cancelledResting.tradeId, status: cancelledResting.status,
    cancellationTransactionHash: cancelledResting.transactionHash,
  });

  try {
    await call("request_trade", market(firstToken, secondToken, "fok", "1000000000"));
    throw new Error("FOK against thin depth was accepted");
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "FOK against thin depth was accepted") throw error;
    if (!(error instanceof Error) || !/fok-unfillable/u.test(error.message)) {
      throw error instanceof Error ? error : new Error("FOK rejection produced an unexpected failure");
    }
    records.push({ name: "fokThinBook", rejected: true });
  }

  const stop = await post(call, {
    sellToken: { type: "address", address: firstToken }, buyToken: { type: "address", address: secondToken },
    amount: { side: "sell", value: "1" },
    policy: { kind: "stopMarket", triggerPrice: "0.0008", slippageBps: "50", timeInForce: "ioc" },
  }, { disposition: "conditional", matching: "rests" });
  records.push({
    name: "stopLossArmed", tradeId: stop.submitted.tradeId, previewId: stop.preview.previewId,
    disposition: stop.preview.disposition, matchingOutcome: stop.preview.matching?.outcome ?? null,
    status: stop.submitted.status, fundingTransactionHash: stop.submitted.fundingTransactionHash,
  });
  await waitStatus(call, stop.submitted.tradeId, ["armed"]);
  const cancelledStop = cancellationSchema.parse(await call("cancel_trade", { tradeId: stop.submitted.tradeId }));
  records.push({
    name: "cancelArmedStop", tradeId: cancelledStop.tradeId, status: cancelledStop.status,
    cancellationTransactionHash: cancelledStop.transactionHash,
  });

  const stopFire = await post(call, {
    sellToken: { type: "address", address: firstToken }, buyToken: { type: "address", address: secondToken },
    amount: { side: "sell", value: "1" },
    policy: { kind: "stopMarket", triggerPrice: "0.0008", slippageBps: "50", timeInForce: "ioc" },
  }, { disposition: "conditional" });
  await waitStatus(call, stopFire.submitted.tradeId, ["armed"]);
  await lowerUsdEthBid();
  await waitForWorker();
  const stopFired = await waitStatus(call, stopFire.submitted.tradeId, ["broadcast"]);
  records.push({
    name: "stopLossFired", tradeId: stopFire.submitted.tradeId, previewId: stopFire.preview.previewId,
    disposition: stopFire.preview.disposition, status: stopFired.status,
    tradeTransactionHash: stopFired.lifecycleTransactionHash,
    fundingTransactionHash: stopFire.submitted.fundingTransactionHash,
  });

  const takeProfit = await post(call, {
    sellToken: { type: "address", address: firstToken }, buyToken: { type: "address", address: secondToken },
    amount: { side: "sell", value: "1" },
    policy: { kind: "takeProfitMarket", triggerPrice: "0.002", slippageBps: "50", timeInForce: "ioc" },
  }, { disposition: "conditional" });
  await waitStatus(call, takeProfit.submitted.tradeId, ["armed"]);
  await raiseUsdEthBid();
  await waitForWorker();
  const tpFired = await waitStatus(call, takeProfit.submitted.tradeId, ["broadcast"]);
  records.push({
    name: "takeProfitFired", tradeId: takeProfit.submitted.tradeId, previewId: takeProfit.preview.previewId,
    disposition: takeProfit.preview.disposition, status: tpFired.status,
    tradeTransactionHash: tpFired.lifecycleTransactionHash,
    fundingTransactionHash: takeProfit.submitted.fundingTransactionHash,
  });

  const oco = await post(call, {
    sellToken: { type: "address", address: firstToken }, buyToken: { type: "address", address: secondToken },
    amount: { side: "sell", value: "1" },
    policy: { kind: "oco", takeProfitPrice: "0.002", stopLossPrice: "0.0005" },
  }, { disposition: "conditional" });
  await waitStatus(call, oco.submitted.tradeId, ["armed"]);
  await raiseUsdEthBid();
  await waitForWorker();
  const ocoFired = await waitStatus(call, oco.submitted.tradeId, ["broadcast"]);
  records.push({
    name: "oco", tradeId: oco.submitted.tradeId, previewId: oco.preview.previewId,
    disposition: oco.preview.disposition, status: ocoFired.status,
    tradeTransactionHash: ocoFired.lifecycleTransactionHash,
    fundingTransactionHash: oco.submitted.fundingTransactionHash,
  });

  return records;
};
