const decimalLanguage = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

/** Parses the intentionally small HTTP decimal language without IEEE-754 arithmetic. */
export const parseTokenAmount = (value: string, decimals: number): bigint => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Token decimals must be an integer from 0 through 255");
  if (!decimalLanguage.test(value)) throw new Error("Amount must be a canonical unsigned decimal string");
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("Amount has more fractional digits than the token supports");
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units === 0n) throw new Error("Amount must be greater than zero");
  return units;
};

export const formatTokenAmount = (value: bigint, decimals: number): string => {
  if (value < 0n) throw new Error("Token amount cannot be negative");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Token decimals must be an integer from 0 through 255");
  if (decimals === 0) return value.toString(10);
  const padded = value.toString(10).padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
};
