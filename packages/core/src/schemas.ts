import { z } from "zod";

const addressPattern = /^0x[0-9a-fA-F]{40}$/u;
const hexPattern = /^0x(?:[0-9a-fA-F]{2})*$/u;
const decimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const integerDecimalPattern = /^(?:0|[1-9][0-9]*)$/u;

export const addressSchema = z.string().regex(addressPattern, "Expected a 20-byte EVM address")
  .transform((value) => value.toLowerCase()).brand<"Hex">().brand<"Address">();
export const hexSchema = z.string().regex(hexPattern, "Expected even-length 0x-prefixed hexadecimal")
  .transform((value) => value.toLowerCase()).brand<"Hex">();
export const hashSchema = hexSchema.refine((value) => value.length === 66, "Expected a 32-byte hash")
  .brand<"Hash">();
export const quantitySchema = z.templateLiteral(["0x", z.string()])
  .refine((value) => /^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value), "Expected a canonical JSON-RPC quantity")
  .brand<"Quantity">();
export const positiveAmountSchema = z.string().regex(decimalPattern)
  .refine((value) => /[1-9]/u.test(value), "Amount must be greater than zero")
  .brand<"DecimalAmount">();

const timingFields = {
  deadline: z.iso.datetime({ offset: true }).optional(),
  lifetimeSeconds: z.number().int().min(1).max(31_536_000).optional(),
} as const;

export const directSwapRequestSchema = z.object({
  routerKind: z.enum(["aquaAmm", "aquaLimit"]).default("aquaAmm"),
  encodedOrder: hexSchema,
  tokenIn: addressSchema,
  tokenOut: addressSchema,
  amountIn: positiveAmountSchema.optional(),
  amountOut: positiveAmountSchema.optional(),
  slippageBps: z.number().int().min(0).max(10_000).default(50),
  ...timingFields,
  recipient: addressSchema.optional(),
  payWithNative: z.boolean().default(false),
  receiveNative: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.tokenIn === value.tokenOut) {
    context.addIssue({ code: "custom", message: "tokenIn and tokenOut must differ", path: ["tokenOut"] });
  }
  if ((value.amountIn === undefined) === (value.amountOut === undefined)) {
    context.addIssue({ code: "custom", message: "Provide exactly one of amountIn or amountOut", path: ["amountIn"] });
  }
  if (value.deadline !== undefined && value.lifetimeSeconds !== undefined) {
    context.addIssue({ code: "custom", message: "Provide deadline or lifetimeSeconds, not both", path: ["deadline"] });
  }
});

export const limitOrderRequestSchema = z.object({
  sellToken: addressSchema,
  buyToken: addressSchema,
  sellAmount: positiveAmountSchema,
  buyAmount: positiveAmountSchema,
  fillPolicy: z.enum(["partial", "allOrNothing"]).optional(),
  timeInForce: z.enum(["GTC", "GTD", "IOC", "FOK"]).default("GTC"),
  nonce: z.number().int().min(0).max(0xffff_ffff).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  lifetimeSeconds: z.number().int().min(1).max(31_536_000).optional(),
  salt: hexSchema.refine((value) => value.length === 66, "salt must contain exactly 32 bytes").optional(),
}).strict().superRefine((value, context) => {
  if (value.sellToken === value.buyToken) {
    context.addIssue({ code: "custom", message: "sellToken and buyToken must differ", path: ["buyToken"] });
  }
  if (value.expiresAt !== undefined && value.lifetimeSeconds !== undefined) {
    context.addIssue({ code: "custom", message: "Provide expiresAt or lifetimeSeconds, not both", path: ["expiresAt"] });
  }
  if (value.timeInForce === "GTD" && value.expiresAt === undefined && value.lifetimeSeconds === undefined) {
    context.addIssue({ code: "custom", message: "GTD requires expiresAt or lifetimeSeconds", path: ["timeInForce"] });
  }
  if (value.timeInForce === "FOK" && value.fillPolicy === "partial") {
    context.addIssue({ code: "custom", message: "FOK cannot use partial fills", path: ["fillPolicy"] });
  }
});

export const limitOrderCancellationSchema = z.object({
  orderHash: hashSchema,
  sellToken: addressSchema,
  buyToken: addressSchema,
}).strict().refine((value) => value.sellToken !== value.buyToken, {
  message: "sellToken and buyToken must differ", path: ["buyToken"],
});

export const nativeAmountSchema = z.object({ amount: positiveAmountSchema }).strict();

export type DirectSwapRequest = z.infer<typeof directSwapRequestSchema>;
export type LimitOrderRequest = z.infer<typeof limitOrderRequestSchema>;
export type LimitOrderCancellation = z.infer<typeof limitOrderCancellationSchema>;
export type NativeAmount = z.infer<typeof nativeAmountSchema>;

export const challengeRequestSchema = z.object({ address: addressSchema }).strict();
export const sessionRequestSchema = z.object({
  challengeId: z.uuid(),
  message: z.string().min(1).max(4_096),
  signature: hexSchema.refine((value) => value.length === 132, "signature must contain 65 bytes"),
}).strict();

export const activityClassificationSchema = z.enum([
  "buy", "sell", "sent", "received", "minted", "burned", "selfTransfer",
]);
export const subscriptionRequestSchema = z.object({ address: addressSchema }).strict();
const canonicalPageSizeSchema = z.string().regex(/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/u)
  .transform((value) => Number(value));
export const activityListQuerySchema = z.object({
  address: addressSchema.optional(),
  classification: activityClassificationSchema.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u).optional(),
  limit: canonicalPageSizeSchema.default(50),
}).strict().superRefine((value, context) => {
  if (value.from !== undefined && value.to !== undefined && value.from >= value.to) {
    context.addIssue({ code: "custom", message: "from must precede to", path: ["from"] });
  }
});
export const activityWipeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("address"), address: addressSchema }).strict(),
  z.object({ scope: z.literal("all"), confirmation: z.literal("WIPE_ALL_ERC20_ACTIVITY") }).strict(),
]);

export type ActivityClassification = z.infer<typeof activityClassificationSchema>;
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;
export type ActivityWipe = z.infer<typeof activityWipeSchema>;

const boundedDecimalSchema = z.string().min(1).max(160).regex(decimalPattern, "Expected a canonical unsigned decimal string");
const positiveDecimalSchema = boundedDecimalSchema.refine((value) => /[1-9]/u.test(value), "Value must be greater than zero");
const unsignedIntegerStringSchema = z.string().min(1).max(20).regex(integerDecimalPattern, "Expected a canonical unsigned integer string");
const pageLimitSchema = unsignedIntegerStringSchema.refine((value) => BigInt(value) >= 1n && BigInt(value) <= 200n, "Limit must be from 1 through 200");
const depthSchema = unsignedIntegerStringSchema.refine((value) => BigInt(value) >= 1n && BigInt(value) <= 100n, "Depth must be from 1 through 100");
const pairSchema = z.object({ baseToken: addressSchema, quoteToken: addressSchema }).strict()
  .refine((value) => value.baseToken !== value.quoteToken, { message: "Pair tokens must differ", path: ["quoteToken"] });
const sideSchema = z.enum(["buy", "sell"]);
const sizeSchema = z.object({
  denomination: z.enum(["base", "quote"]),
  amount: positiveDecimalSchema,
}).strict();
const orderIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9:/.\-_]+$/u, "Invalid order identifier");
const bpsSchema = unsignedIntegerStringSchema.refine((value) => BigInt(value) <= 10_000n, "Basis points cannot exceed 10000");
const lifetimeSchema = unsignedIntegerStringSchema.refine(
  (value) => BigInt(value) >= 1n && BigInt(value) <= 31_536_000n,
  "Lifetime must be from 1 through 31536000 seconds",
);
const prepareSwapSchema = z.object({
  routerKind: z.enum(["aquaAmm", "aquaLimit"]).default("aquaAmm"),
  encodedOrder: hexSchema,
  tokenIn: addressSchema,
  tokenOut: addressSchema,
  amountIn: positiveDecimalSchema.optional(),
  amountOut: positiveDecimalSchema.optional(),
  slippageBps: bpsSchema.default("50").transform((value) => Number(value)),
  deadline: z.iso.datetime({ offset: true }).optional(),
  lifetimeSeconds: lifetimeSchema.transform((value) => Number(value)).optional(),
  recipient: addressSchema.optional(),
  payWithNative: z.boolean().default(false),
  receiveNative: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.tokenIn === value.tokenOut) {
    context.addIssue({ code: "custom", message: "tokenIn and tokenOut must differ", path: ["tokenOut"] });
  }
  if ((value.amountIn === undefined) === (value.amountOut === undefined)) {
    context.addIssue({ code: "custom", message: "Provide exactly one of amountIn or amountOut", path: ["amountIn"] });
  }
  if (value.deadline !== undefined && value.lifetimeSeconds !== undefined) {
    context.addIssue({ code: "custom", message: "Provide deadline or lifetimeSeconds, not both", path: ["deadline"] });
  }
});
const timeInForceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gtc") }).strict(),
  z.object({ kind: z.literal("gtd"), expiresAt: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal("gtd"), lifetimeSeconds: lifetimeSchema }).strict(),
  z.object({ kind: z.literal("ioc") }).strict(),
  z.object({ kind: z.literal("fok") }).strict(),
]);
const restingTimeInForceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gtc") }).strict(),
  z.object({ kind: z.literal("gtd"), expiresAt: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal("gtd"), lifetimeSeconds: lifetimeSchema }).strict(),
]);
const commonOrderShape = { pair: pairSchema, side: sideSchema, size: sizeSchema } as const;
const marketOrderSchema = z.object({
  kind: z.literal("market"), ...commonOrderShape,
  timeInForce: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ioc") }).strict(), z.object({ kind: z.literal("fok") }).strict(),
  ]).default({ kind: "ioc" }),
  slippageBps: bpsSchema.default("50"),
}).strict();
const limitOrderV2Schema = z.object({
  kind: z.literal("limit"), ...commonOrderShape,
  limitPrice: positiveDecimalSchema,
  timeInForce: timeInForceSchema.default({ kind: "gtc" }),
  fillPolicy: z.enum(["partial", "allOrNone"]).optional(),
  postPolicy: z.enum(["normal", "postOnly", "bookOrCancel"]).default("normal"),
}).strict().superRefine((value, context) => {
  if (value.timeInForce.kind === "fok" && value.fillPolicy !== undefined) {
    context.addIssue({ code: "custom", path: ["fillPolicy"], message: "FOK already implies allOrNone; omit fillPolicy" });
  }
  if ((value.timeInForce.kind === "ioc" || value.timeInForce.kind === "fok") && value.postPolicy !== "normal") {
    context.addIssue({ code: "custom", path: ["postPolicy"], message: "Immediate orders cannot be post-only" });
  }
}).transform((value) => ({ ...value, fillPolicy: value.timeInForce.kind === "fok" ? "allOrNone" as const : value.fillPolicy ?? "partial" as const }));
const triggerMarketSchema = z.object({
  kind: z.enum(["stopMarket", "takeProfitMarket"]), ...commonOrderShape,
  triggerPrice: positiveDecimalSchema,
  timeInForce: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ioc") }).strict(), z.object({ kind: z.literal("fok") }).strict(),
  ]).default({ kind: "ioc" }),
  slippageBps: bpsSchema.default("50"),
}).strict();
const triggerLimitSchema = z.object({
  kind: z.enum(["stopLimit", "takeProfitLimit"]), ...commonOrderShape,
  triggerPrice: positiveDecimalSchema, limitPrice: positiveDecimalSchema,
  timeInForce: restingTimeInForceSchema.default({ kind: "gtc" }),
  fillPolicy: z.enum(["partial", "allOrNone"]).default("partial"),
}).strict();
const trailingStopSchema = z.object({
  kind: z.literal("trailingStop"), ...commonOrderShape,
  trail: z.discriminatedUnion("unit", [
    z.object({ unit: z.literal("bps"), value: bpsSchema.refine((value) => BigInt(value) > 0n) }).strict(),
    z.object({ unit: z.literal("quote"), value: positiveDecimalSchema }).strict(),
  ]),
  activationPrice: positiveDecimalSchema.optional(),
  timeInForce: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ioc") }).strict(), z.object({ kind: z.literal("fok") }).strict(),
  ]).default({ kind: "ioc" }),
  slippageBps: bpsSchema.default("50"),
}).strict();
const ocoSchema = z.object({
  kind: z.literal("oco"), ...commonOrderShape,
  takeProfitPrice: positiveDecimalSchema, stopLossPrice: positiveDecimalSchema,
  limitPrice: positiveDecimalSchema.optional(),
  timeInForce: restingTimeInForceSchema.default({ kind: "gtc" }),
}).strict();
const bracketSchema = z.object({
  kind: z.literal("bracket"), ...commonOrderShape,
  entry: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("market"), slippageBps: bpsSchema.default("50") }).strict(),
    z.object({ kind: z.literal("limit"), limitPrice: positiveDecimalSchema }).strict(),
  ]),
  takeProfitPrice: positiveDecimalSchema, stopLossPrice: positiveDecimalSchema,
  timeInForce: restingTimeInForceSchema.default({ kind: "gtc" }),
}).strict();

export const tradingOrderSchema = z.union([
  marketOrderSchema, limitOrderV2Schema, triggerMarketSchema, triggerLimitSchema, trailingStopSchema, ocoSchema, bracketSchema,
]);
const createOrderCommandSchema = z.object({ action: z.literal("createOrder"), order: tradingOrderSchema }).strict();
const amendOrderCommandSchema = z.object({
  action: z.literal("amendOrder"), orderId: orderIdSchema, replacement: tradingOrderSchema,
}).strict();
const cancelOrdersCommandSchema = z.object({
  action: z.literal("cancelOrders"),
  selection: z.discriminatedUnion("scope", [
    z.object({ scope: z.literal("selected"), orderIds: z.array(orderIdSchema).min(1).max(100) }).strict(),
    z.object({ scope: z.literal("allOpen"), pair: pairSchema.optional() }).strict(),
  ]),
}).strict();
const executeOrderCommandSchema = z.object({
  action: z.literal("executeOrder"), orderId: orderIdSchema, size: sizeSchema,
  slippageBps: bpsSchema.default("50"),
}).strict();
const batchOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), order: tradingOrderSchema }).strict(),
  z.object({ operation: z.literal("amend"), orderId: orderIdSchema, replacement: tradingOrderSchema }).strict(),
  z.object({ operation: z.literal("cancel"), orderId: orderIdSchema }).strict(),
]);
const batchCommandSchema = z.object({ action: z.literal("batch"), operations: z.array(batchOperationSchema).min(1).max(20) }).strict();
const querySchema = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("order"), orderId: orderIdSchema }).strict(),
  z.object({ resource: z.literal("orders"), status: z.enum(["pending", "open", "partiallyFilled", "filled", "cancelled", "expired", "rejected"]).optional(), pair: pairSchema.optional(), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u).optional(), limit: pageLimitSchema.default("50") }).strict(),
  z.object({ resource: z.literal("fills"), orderId: orderIdSchema.optional(), pair: pairSchema.optional(), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u).optional(), limit: pageLimitSchema.default("50") }).strict(),
  z.object({ resource: z.literal("orderBook"), pair: pairSchema, depth: depthSchema.default("20") }).strict(),
  z.object({ resource: z.literal("ticker"), pair: pairSchema }).strict(),
  z.object({ resource: z.literal("recentTrades"), pair: pairSchema, cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u).optional(), limit: pageLimitSchema.default("50") }).strict(),
  z.object({ resource: z.literal("candles"), pair: pairSchema, interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u).optional(), limit: pageLimitSchema.default("100") }).strict(),
  z.object({ resource: z.literal("balances"), tokens: z.array(addressSchema).min(1).max(50) }).strict(),
  z.object({ resource: z.literal("fees"), pair: pairSchema.optional() }).strict(),
]);
const queryCommandSchema = z.object({ action: z.literal("query"), query: querySchema }).strict();
const wrappedNativeCommandSchema = z.object({
  action: z.literal("manageWrappedNative"), operation: z.enum(["wrap", "unwrap"]), amount: positiveDecimalSchema,
}).strict();
const prepareSwapCommandSchema = z.object({ action: z.literal("prepareSwap"), swap: prepareSwapSchema }).strict();

export const tradingRequestSchema = z.discriminatedUnion("action", [
  createOrderCommandSchema, amendOrderCommandSchema, cancelOrdersCommandSchema, executeOrderCommandSchema,
  batchCommandSchema, queryCommandSchema, wrappedNativeCommandSchema, prepareSwapCommandSchema,
]);
export type TradingRequest = z.infer<typeof tradingRequestSchema>;
export type TradingOrder = z.infer<typeof tradingOrderSchema>;
