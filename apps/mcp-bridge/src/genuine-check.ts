export interface GenuineCheckState {
  passed: boolean;
}

export const genuineCheckRequired = (state: GenuineCheckState, aquaE2e: string | undefined): boolean => {
  if (aquaE2e === "1") return false;
  return !state.passed;
};

export const rewriteGenuineCheckFailure = (output: string): string => {
  const trimmed = output.trim();
  const detail = trimmed.includes("wrong_app")
    ? `${trimmed}\nQuit to the dashboard (both-button Quit). Do not open Ethereum until the device asks.`
    : trimmed;
  return `Ledger genuine check failed: ${detail}`;
};
