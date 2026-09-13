export const bufferedGasLimit = (estimated: bigint): bigint => estimated + estimated / 2n + 30_000n;

export const shouldSkipTokenApprove = (input: { readonly allowance: bigint; readonly required: bigint }): boolean =>
  input.allowance >= input.required;
