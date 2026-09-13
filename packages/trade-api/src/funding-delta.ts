export type FundingReceipt = "missing" | "success" | "reverted";
export type FundingConfirmation = "exact" | "pending" | "mismatch";

export const fundingConfirmation = (input: {
  readonly receipt: FundingReceipt;
  readonly delta: bigint;
  readonly expected: bigint;
  readonly terminal?: boolean;
}): FundingConfirmation => {
  if (input.delta === input.expected) return "exact";
  if (input.receipt === "reverted") return "mismatch";
  if (input.receipt === "missing" || input.terminal !== true) return "pending";
  return "mismatch";
};
