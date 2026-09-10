import { z } from "zod";
import { addressSchema, hashSchema, hexSchema, positiveAmountSchema } from "./schemas.ts";

export const tokenReferenceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("address"), address: addressSchema }).strict(),
  z.object({ type: z.literal("search"), query: z.string().trim().min(1).max(128) }).strict(),
  z.object({ type: z.literal("native") }).strict(),
]);

const bps = z.string().regex(/^(?:0|[1-9][0-9]{0,4})$/u).refine((value) => BigInt(value) <= 10_000n, "Basis points cannot exceed 10000");
const price = positiveAmountSchema;
const expiry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gtc") }).strict(),
  z.object({ kind: z.literal("gtd"), expiresAt: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal("ioc") }).strict(),
  z.object({ kind: z.literal("fok") }).strict(),
]);
const restingExpiry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gtc") }).strict(),
  z.object({ kind: z.literal("gtd"), expiresAt: z.iso.datetime({ offset: true }) }).strict(),
]);
const marketPolicy = z.object({ kind: z.literal("market"), slippageBps: bps.default("50"), timeInForce: z.enum(["ioc", "fok"]).default("ioc") }).strict();
const limitPolicy = z.object({
  kind: z.literal("limit"), limitPrice: price, timeInForce: expiry.default({ kind: "gtc" }),
  fillPolicy: z.enum(["partial", "allOrNone"]).default("partial"),
  postPolicy: z.enum(["normal", "postOnly", "bookOrCancel"]).default("normal"),
}).strict();
const triggerMarketPolicy = z.object({
  kind: z.enum(["stopMarket", "takeProfitMarket"]), triggerPrice: price,
  slippageBps: bps.default("50"), timeInForce: z.enum(["ioc", "fok"]).default("ioc"),
}).strict();
const triggerLimitPolicy = z.object({
  kind: z.enum(["stopLimit", "takeProfitLimit"]), triggerPrice: price, limitPrice: price,
  timeInForce: restingExpiry.default({ kind: "gtc" }), fillPolicy: z.enum(["partial", "allOrNone"]).default("partial"),
}).strict();
const trailingStopPolicy = z.object({
  kind: z.literal("trailingStop"), trail: z.discriminatedUnion("unit", [
    z.object({ unit: z.literal("bps"), value: bps.refine((value) => BigInt(value) > 0n, "Trail must be greater than zero") }).strict(),
    z.object({ unit: z.literal("quote"), value: price }).strict(),
  ]), activationPrice: price.optional(), slippageBps: bps.default("50"), timeInForce: z.enum(["ioc", "fok"]).default("ioc"),
}).strict();
const ocoPolicy = z.object({
  kind: z.literal("oco"), takeProfitPrice: price, stopLossPrice: price, limitPrice: price.optional(),
  timeInForce: restingExpiry.default({ kind: "gtc" }),
}).strict();
const bracketPolicy = z.object({
  kind: z.literal("bracket"), entry: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("market"), slippageBps: bps.default("50") }).strict(),
    z.object({ kind: z.literal("limit"), limitPrice: price }).strict(),
  ]), takeProfitPrice: price, stopLossPrice: price, timeInForce: restingExpiry.default({ kind: "gtc" }),
}).strict();

export const tradePolicySchema = z.union([
  marketPolicy, limitPolicy, triggerMarketPolicy, triggerLimitPolicy, trailingStopPolicy, ocoPolicy, bracketPolicy,
]);

export const tradePreviewRequestSchema = z.object({
  sellToken: tokenReferenceSchema,
  buyToken: tokenReferenceSchema,
  amount: z.object({ side: z.enum(["sell", "buy"]), value: positiveAmountSchema }).strict(),
  policy: tradePolicySchema.default({ kind: "market", slippageBps: "50", timeInForce: "ioc" }),
  recipient: addressSchema.optional(),
}).strict();

export const agentChallengeRequestSchema = z.object({ agent: addressSchema }).strict();
export const agentBindingRequestSchema = z.object({ challengeId: z.uuid(), agent: addressSchema, signature: hexSchema.refine((value) => value.length === 132, "signature must contain 65 bytes") }).strict();
export const delegationPreviewRequestSchema = z.object({
  agent: addressSchema, token: addressSchema, maxPerOrder: positiveAmountSchema,
  maxPerDay: positiveAmountSchema, expiresAt: z.iso.datetime({ offset: true }),
}).strict();
export const delegationSubmitRequestSchema = z.object({ previewId: z.uuid(), previewHash: hashSchema, ownerSignature: hexSchema.refine((value) => value.length === 132, "signature must contain 65 bytes") }).strict();
export const tradeSubmitRequestSchema = z.object({
  previewId: z.uuid(), previewHash: hashSchema,
  lifecycleSignature: hexSchema.refine((value) => value.length === 132, "signature must contain 65 bytes"),
  additionalLifecycleSignatures: z.array(hexSchema.refine((value) => value.length === 132, "signature must contain 65 bytes")).max(4).optional(),
}).strict();
export const tradeCancellationSubmitRequestSchema = z.object({
  signature: hexSchema.refine((value) => value.length === 132, "signature must contain 65 bytes"),
}).strict();

const pageSize = z.string().regex(/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/u).transform(Number);
export const tradesListQuerySchema = z.object({
  source: z.enum(["own", "subscriptions", "all"]).default("own"), status: z.string().min(1).max(64).optional(),
  address: addressSchema.optional(), token: addressSchema.optional(), kind: z.string().min(1).max(64).optional(),
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
  sort: z.enum(["occurredAt", "updatedAt"]).default("occurredAt"), direction: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u).optional(), limit: pageSize.default(50),
}).strict().refine((value) => value.from === undefined || value.to === undefined || value.from < value.to, { path: ["from"], message: "from must precede to" });

export const subscribedTradesWipeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("address"), address: addressSchema }).strict(),
  z.object({ scope: z.literal("all"), confirmation: z.literal("WIPE_ALL_SUBSCRIBED_TRADES") }).strict(),
]);

export type TokenReference = z.infer<typeof tokenReferenceSchema>;
export type TradePolicy = z.infer<typeof tradePolicySchema>;
export type TradePreviewRequest = z.infer<typeof tradePreviewRequestSchema>;
export type TradesListQuery = z.infer<typeof tradesListQuerySchema>;
export type SubscribedTradesWipe = z.infer<typeof subscribedTradesWipeSchema>;
