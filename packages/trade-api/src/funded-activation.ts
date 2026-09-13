export const previewSubmitAllowed = (input: {
  readonly expiresAt: Date;
  readonly now: Date;
  readonly paymentTransaction: string | null | undefined;
}): boolean => input.expiresAt > input.now || input.paymentTransaction != null;

export type FundedActivationDecision =
  | { readonly action: "deploy" }
  | { readonly action: "waitDeploy"; readonly activationError: string }
  | { readonly action: "execute" };

const emptyCode = (vaultCode: string): boolean => vaultCode === "0x" || vaultCode === "";

export const nextFundedActivation = (input: {
  readonly vaultCode: string;
  readonly deploymentTransaction: string | null;
  readonly deploymentReceipt: "missing" | "success" | "reverted" | null;
}): FundedActivationDecision => {
  if (!emptyCode(input.vaultCode)) return { action: "execute" };
  if (input.deploymentTransaction === null) return { action: "deploy" };
  if (input.deploymentReceipt === "reverted") return { action: "deploy" };
  if (input.deploymentReceipt === "missing" || input.deploymentReceipt === null) {
    return { action: "waitDeploy", activationError: "vault deployment submitted; call post_trade again with the same ids" };
  }
  return { action: "waitDeploy", activationError: "vault code not yet observed; call post_trade again with the same ids" };
};
