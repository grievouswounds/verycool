import type { ActivityClassification, Address, Hash } from "@aqua/core";

export interface RawTransfer {
  readonly token: Address;
  readonly from: Address;
  readonly to: Address;
  readonly amount: bigint;
  readonly transactionHash: Hash;
  readonly logIndex: bigint;
}

export type ClassifiedTransfer<Transfer extends RawTransfer = RawTransfer> = Transfer & {
  readonly classification: ActivityClassification;
  readonly classificationSource: "transferSemantics" | "inferredCounterflow";
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const classifyTransfers = <Transfer extends RawTransfer>(watched: Address, transfers: readonly Transfer[]): readonly ClassifiedTransfer<Transfer>[] => {
  const incomingTokens = new Set(transfers.filter((item) => item.to === watched && item.from !== watched).map((item) => item.token));
  const outgoingTokens = new Set(transfers.filter((item) => item.from === watched && item.to !== watched).map((item) => item.token));
  return transfers.map((transfer): ClassifiedTransfer<Transfer> => {
    if (transfer.from === watched && transfer.to === watched) return { ...transfer, classification: "selfTransfer", classificationSource: "transferSemantics" };
    if (transfer.from === ZERO_ADDRESS && transfer.to === watched) return { ...transfer, classification: "minted", classificationSource: "transferSemantics" };
    if (transfer.from === watched && transfer.to === ZERO_ADDRESS) return { ...transfer, classification: "burned", classificationSource: "transferSemantics" };
    const incoming = transfer.to === watched;
    const counterflow = incoming
      ? [...outgoingTokens].some((token) => token !== transfer.token)
      : [...incomingTokens].some((token) => token !== transfer.token);
    return {
      ...transfer,
      classification: counterflow ? incoming ? "buy" : "sell" : incoming ? "received" : "sent",
      classificationSource: counterflow ? "inferredCounterflow" : "transferSemantics",
    };
  });
};
