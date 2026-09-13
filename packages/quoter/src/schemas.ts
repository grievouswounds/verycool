import { z } from "zod";

export const currencySchema = z.string().regex(/^[A-Z]{3,8}$/u, "Currency must contain 3-8 uppercase ASCII letters");
export const tokenNameSchema = z.string().min(1).max(64).transform((value) => value.normalize("NFC"))
  .refine((value) => !/\p{Cc}/u.test(value), "Token name must not contain control characters");
