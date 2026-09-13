export const awaitingDelegation = (
  previewId: string,
  previewHash: string,
  transactionHash: string,
): Readonly<Record<string, string>> => ({
  status: "awaiting_delegation",
  previewId,
  previewHash,
  transactionHash,
  next: "Call post_trade again with the same previewId and previewHash. Do not wait in this call for Sepolia confirmation.",
});
