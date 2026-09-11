import { addressSchema } from "@aqua/core";
import type { Address, Hash, RpcCall, RpcPort, RpcStateOverrides, UnsignedTransaction } from "@aqua/core";
import { decodeUint256, encodeAllowance, encodeBalanceOf, erc20BalanceSlot, mappingStorageSlot, uint256SlotValue } from "@aqua/evm";

export interface SafetyCheck {
  readonly name: string;
  readonly safe: boolean;
  readonly severity: "info" | "warning" | "malicious";
  readonly [key: string]: unknown;
}

export interface SafetyReport {
  readonly safe: boolean;
  readonly verdict: "benign" | "warning" | "malicious";
  readonly checks: readonly SafetyCheck[];
  readonly warnings: readonly string[];
}

const approveSelector = "0x095ea7b3";
const balanceSlotCache = new Map<Address, bigint>();
const allowanceSlotCache = new Map<Address, bigint>();

const asAddress = (value: string): Address => addressSchema.parse(value);

const findBalanceSlot = async (rpc: RpcPort, token: Address, account: Address): Promise<bigint> => {
  const cached = balanceSlotCache.get(token);
  if (cached !== undefined) return cached;
  const probe = 10n ** 18n + 7n;
  for (let slot = 0n; slot <= 20n; slot += 1n) {
    const key = erc20BalanceSlot(account, slot);
    try {
      const result = decodeUint256(await rpc.call({ to: token, data: encodeBalanceOf(account) }, {
        [token]: { stateDiff: { [key]: uint256SlotValue(probe) } },
      }));
      if (result === probe) { balanceSlotCache.set(token, slot); return slot; }
    } catch { /* slot candidate did not control balanceOf */ }
  }
  throw new Error("Could not locate ERC-20 balance storage slot for funded simulation");
};

const allowanceKey = (owner: Address, spender: Address, mappingSlot: bigint): Hash =>
  mappingStorageSlot(spender, BigInt(mappingStorageSlot(owner, mappingSlot)));

const findAllowanceSlot = async (rpc: RpcPort, token: Address, owner: Address, spender: Address): Promise<bigint> => {
  const cached = allowanceSlotCache.get(token);
  if (cached !== undefined) return cached;
  const probe = 10n ** 18n + 11n;
  for (let slot = 0n; slot <= 20n; slot += 1n) {
    const key = allowanceKey(owner, spender, slot);
    try {
      const result = decodeUint256(await rpc.call({ to: token, data: encodeAllowance(owner, spender) }, {
        [token]: { stateDiff: { [key]: uint256SlotValue(probe) } },
      }));
      if (result === probe) { allowanceSlotCache.set(token, slot); return slot; }
    } catch { /* slot candidate did not control allowance */ }
  }
  throw new Error("Could not locate ERC-20 allowance storage slot for funded simulation");
};

const tokenOverride = async (rpc: RpcPort, token: Address, account: Address, amount: bigint): Promise<RpcStateOverrides> => {
  const slot = await findBalanceSlot(rpc, token, account);
  return { [token]: { stateDiff: { [erc20BalanceSlot(account, slot)]: uint256SlotValue(amount) } } };
};

const allowanceOverride = async (
  rpc: RpcPort, token: Address, owner: Address, spender: Address, amount: bigint,
): Promise<RpcStateOverrides> => {
  const slot = await findAllowanceSlot(rpc, token, owner, spender);
  return { [token]: { stateDiff: { [allowanceKey(owner, spender, slot)]: uint256SlotValue(amount) } } };
};

const mergeOverrides = (left: RpcStateOverrides, right: RpcStateOverrides): RpcStateOverrides => {
  const merged: Record<string, typeof left[string]> = { ...left };
  for (const [address, override] of Object.entries(right)) {
    const current = merged[address] ?? {};
    merged[address] = {
      ...current, ...override,
      stateDiff: { ...current.stateDiff, ...override.stateDiff },
    };
  }
  return merged;
};

const permit2AllowanceSlot = (owner: Address, token: Address, spender: Address): Hash => {
  const ownerSlot = mappingStorageSlot(owner, 1n);
  const tokenSlot = mappingStorageSlot(token, BigInt(ownerSlot));
  return mappingStorageSlot(spender, BigInt(tokenSlot));
};

export const simulateFundedCalls = async (input: {
  readonly rpc: RpcPort;
  readonly calls: readonly UnsignedTransaction[];
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly vault: Address;
  readonly owner: Address;
  readonly agent: Address;
  readonly fundingAmount: bigint;
  readonly minimumOutput: bigint;
  readonly permit2: Address;
  readonly allowedSpenders: readonly Address[];
  readonly spotSell: string | null;
  readonly spotBuy: string | null;
}): Promise<SafetyReport> => {
  const checks: SafetyCheck[] = [];
  const warnings: string[] = [];
  const vaultFunding = await tokenOverride(input.rpc, input.sellToken, input.vault, input.fundingAmount);
  const agentFunding = await tokenOverride(input.rpc, input.sellToken, input.agent, input.fundingAmount);
  const packedPermit = uint256SlotValue((1n << 208n) - 1n);
  const permitSlot = permit2AllowanceSlot(input.agent, input.sellToken, input.permit2);
  const permitOverride: RpcStateOverrides = { [input.permit2]: { stateDiff: { [permitSlot]: packedPermit } } };
  let overrides = mergeOverrides(mergeOverrides(vaultFunding, agentFunding), permitOverride);
  for (const spender of input.allowedSpenders) {
    const amount = input.fundingAmount === 0n ? 1n : input.fundingAmount;
    overrides = mergeOverrides(overrides, await allowanceOverride(input.rpc, input.sellToken, input.vault, spender, amount));
    overrides = mergeOverrides(overrides, await allowanceOverride(input.rpc, input.sellToken, input.agent, spender, amount));
  }
  let anyFailed = false;
  for (const transaction of input.calls) {
    const call: RpcCall = { to: transaction.to, data: transaction.data, from: transaction.from, value: transaction.value };
    try {
      const returnData = await input.rpc.call(call, overrides);
      let gas: string | null = null;
      try { gas = (await input.rpc.estimateGas(call, overrides)).toString(); }
      catch { /* gas estimation is advisory; the funded eth_call is the safety verdict */ }
      checks.push({ name: "rpcCall", target: transaction.to, selector: transaction.data.slice(0, 10), safe: true, severity: "info", gas, returnData });
    } catch (error: unknown) {
      anyFailed = true;
      checks.push({
        name: "rpcCall", target: transaction.to, selector: transaction.data.slice(0, 10), safe: false, severity: "malicious",
        error: error instanceof Error ? error.message : "funded simulation reverted",
      });
    }
    if (transaction.data.startsWith(approveSelector) && transaction.data.length >= 138) {
      const spender = asAddress(`0x${transaction.data.slice(34, 74)}`);
      const amount = BigInt(`0x${transaction.data.slice(74, 138)}`);
      const allowed = input.allowedSpenders.some((item) => item.toLowerCase() === spender.toLowerCase());
      const excessive = amount > input.fundingAmount * 2n && amount !== (1n << 256n) - 1n;
      const unlimited = amount === (1n << 256n) - 1n;
      const ok = allowed && !unlimited && !excessive;
      checks.push({
        name: "approvalScope", spender, amount: amount.toString(), safe: ok,
        severity: allowed ? (unlimited || excessive ? "warning" : "info") : "malicious",
      });
      if (!allowed) warnings.push("Approval targets a spender outside the reviewed Aqua/Permit2 set");
      if (unlimited || excessive) warnings.push("Approval amount is larger than the reviewed trade size");
    }
  }
  if (input.minimumOutput > 0n && input.spotSell !== null && input.spotBuy !== null && input.spotSell !== "0" && input.spotBuy !== "0") {
    const spotOut = input.fundingAmount * BigInt(input.spotSell.replace(".", "")) / (BigInt(input.spotBuy.replace(".", "")) === 0n ? 1n : BigInt(input.spotBuy.replace(".", "")));
    const ratio = spotOut === 0n ? 10_000n : input.minimumOutput * 10_000n / spotOut;
    const weak = ratio < 5_000n;
    const predatory = ratio < 1_000n;
    checks.push({ name: "minimumOutput", safe: !predatory, severity: predatory ? "malicious" : weak ? "warning" : "info", minimumOutputUnits: input.minimumOutput.toString() });
    if (weak) warnings.push("Minimum output is well below the observed spot conversion");
  }
  const ownerBalance = decodeUint256(await input.rpc.call({ to: input.buyToken, data: encodeBalanceOf(input.owner) }));
  checks.push({
    name: "outputRecipient", safe: true, severity: "info",
    owner: input.owner, ownerBuyBalance: ownerBalance.toString(), note: "Vault output is hardcoded to the Ledger owner",
  });
  const allowance = decodeUint256(await input.rpc.call({ to: input.sellToken, data: encodeAllowance(input.agent, input.permit2) }));
  checks.push({ name: "permit2Allowance", safe: true, severity: "info", allowance: allowance.toString() });
  const malicious = checks.some((check) => check.severity === "malicious" || !check.safe);
  const warning = checks.some((check) => check.severity === "warning") || warnings.length > 0;
  const safe = !malicious && !anyFailed;
  return { safe, verdict: malicious ? "malicious" : warning ? "warning" : "benign", checks, warnings };
};
