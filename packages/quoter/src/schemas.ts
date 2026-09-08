import { addressSchema, hexSchema, positiveAmountSchema } from "@aqua/core";
import { z } from "zod";

export const currencySchema = z.string().regex(/^[A-Z]{3,8}$/u, "Currency must contain 3-8 uppercase ASCII letters");
export const tokenNameSchema = z.string().min(1).max(64).transform((value) => value.normalize("NFC"))
  .refine((value) => !/\p{Cc}/u.test(value), "Token name must not contain control characters");

const lifetimeSchema = z.string().regex(/^(?:[1-9]|[1-9][0-9]{1,7})$/u)
  .refine((value) => BigInt(value) <= 31_536_000n, "Lifetime must not exceed one year")
  .transform((value) => Number(value));

export const aquaQuoteRequestSchema = z.object({
  routerKind: z.enum(["aquaAmm", "aquaLimit"]).default("aquaAmm"),
  encodedOrder: hexSchema,
  tokenIn: addressSchema,
  tokenOut: addressSchema,
  amountIn: positiveAmountSchema.optional(),
  amountOut: positiveAmountSchema.optional(),
  deadline: z.iso.datetime({ offset: true }).optional(),
  lifetimeSeconds: lifetimeSchema.optional(),
  recipient: addressSchema.optional(),
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

export type AquaQuoteRequest = z.infer<typeof aquaQuoteRequestSchema>;
