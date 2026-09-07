import { parseTokenAmount } from "./decimal.ts";

interface HumanSize { readonly denomination: "base" | "quote"; readonly amount: string }
interface LimitAmounts { readonly baseUnits: bigint; readonly quoteUnits: bigint }

const ratio = (value: string): { readonly numerator: bigint; readonly denominator: bigint } => {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value) || !/[1-9]/u.test(value)) {
    throw new Error("Price must be a positive canonical decimal string");
  }
  const [whole = "", fraction = ""] = value.split(".");
  return { numerator: BigInt(`${whole}${fraction}`), denominator: 10n ** BigInt(fraction.length) };
};

const ceilDivide = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator;

/** Converts quote-per-base price notation into atomic amounts, rounding only in the maker's favour. */
export const calculateLimitAmounts = (
  side: "buy" | "sell", size: HumanSize, price: string, baseDecimals: number, quoteDecimals: number,
): LimitAmounts => {
  const parsedPrice = ratio(price);
  const baseScale = 10n ** BigInt(baseDecimals);
  const quoteScale = 10n ** BigInt(quoteDecimals);
  if (size.denomination === "base") {
    const baseUnits = parseTokenAmount(size.amount, baseDecimals);
    const numerator = baseUnits * parsedPrice.numerator * quoteScale;
    const denominator = parsedPrice.denominator * baseScale;
    const quoteUnits = side === "sell" ? ceilDivide(numerator, denominator) : numerator / denominator;
    if (quoteUnits === 0n) throw new Error("Price and size round to zero quote units");
    return { baseUnits, quoteUnits };
  }
  const quoteUnits = parseTokenAmount(size.amount, quoteDecimals);
  const numerator = quoteUnits * parsedPrice.denominator * baseScale;
  const denominator = parsedPrice.numerator * quoteScale;
  const baseUnits = side === "sell" ? numerator / denominator : ceilDivide(numerator, denominator);
  if (baseUnits === 0n) throw new Error("Price and size round to zero base units");
  return { baseUnits, quoteUnits };
};
