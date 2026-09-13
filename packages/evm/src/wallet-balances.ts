import { formatTokenAmount } from "@aqua/core";
import type { Address, Hex, RpcCall, RpcPort, RuntimeManifest } from "@aqua/core";
import { decodeUint256, encodeBalanceOf } from "./abi.ts";

export interface WalletBalanceToken {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export interface WalletBalanceTarget {
  readonly role: "owner" | "agent" | "inspect";
  readonly address: Address;
}

export interface WalletBalanceAsset {
  readonly symbol: string;
  readonly token: Address | "native";
  readonly decimals: number;
  readonly units: string;
  readonly amount: string;
}

export interface WalletBalanceSnapshot {
  readonly role: WalletBalanceTarget["role"];
  readonly address: Address;
  readonly assets: readonly WalletBalanceAsset[];
}

export interface WalletBalancesBody {
  readonly chainId: number;
  readonly owner: Address | null;
  readonly agent: Address | null;
  readonly wallets: readonly WalletBalanceSnapshot[];
}

export interface WalletBalanceRpc {
  balance(address: Address): Promise<bigint>;
  call(transaction: RpcCall): Promise<Hex>;
}

export interface ReadWalletBalancesInput {
  readonly rpc: WalletBalanceRpc;
  readonly chainId: number;
  readonly wrappedNative: WalletBalanceToken;
  readonly fixtures: readonly WalletBalanceToken[];
  readonly owner: Address | null;
  readonly agent: Address | null;
  readonly inspect?: Address;
}

const uniqueWallets = (input: ReadWalletBalancesInput): readonly WalletBalanceTarget[] => {
  const wallets: WalletBalanceTarget[] = [];
  if (input.owner !== null) wallets.push({ role: "owner", address: input.owner });
  if (input.agent !== null && input.agent !== input.owner) wallets.push({ role: "agent", address: input.agent });
  if (input.inspect !== undefined && input.inspect !== input.owner && input.inspect !== input.agent) {
    wallets.push({ role: "inspect", address: input.inspect });
  }
  return wallets;
};

const assetsFor = (input: ReadWalletBalancesInput): readonly WalletBalanceToken[] => {
  const seen = new Set<string>([input.wrappedNative.address]);
  const tokens: WalletBalanceToken[] = [input.wrappedNative];
  for (const token of input.fixtures) {
    if (seen.has(token.address)) continue;
    seen.add(token.address);
    tokens.push(token);
  }
  return tokens;
};

const snapshot = async (
  rpc: WalletBalanceRpc,
  wallet: WalletBalanceTarget,
  tokens: readonly WalletBalanceToken[],
): Promise<WalletBalanceSnapshot> => {
  const native = await rpc.balance(wallet.address);
  const erc20 = await Promise.all(tokens.map(async (token) => {
    const units = decodeUint256(await rpc.call({ to: token.address, data: encodeBalanceOf(wallet.address) }));
    return {
      symbol: token.symbol,
      token: token.address,
      decimals: token.decimals,
      units: units.toString(),
      amount: formatTokenAmount(units, token.decimals),
    } satisfies WalletBalanceAsset;
  }));
  return {
    role: wallet.role,
    address: wallet.address,
    assets: [
      { symbol: "ETH", token: "native", decimals: 18, units: native.toString(), amount: formatTokenAmount(native, 18) },
      ...erc20,
    ],
  };
};

export const rpcWithBalance = (rpc: RpcPort): WalletBalanceRpc => {
  const balance = rpc.balance?.bind(rpc);
  if (balance === undefined) throw new Error("RPC client does not implement eth_getBalance");
  return { balance, call: (transaction) => rpc.call(transaction) };
};

export const walletBalanceCatalog = (manifest: RuntimeManifest): Pick<ReadWalletBalancesInput, "chainId" | "wrappedNative" | "fixtures"> => {
  const address = manifest.contracts.wrappedNativeToken.address;
  const fixture = manifest.fixtures.tokens.find((token) => token.address === address);
  return {
    chainId: manifest.chain.id,
    wrappedNative: fixture ?? { address, symbol: "WETH", decimals: 18 },
    fixtures: manifest.fixtures.tokens,
  };
};

export const readWalletBalances = async (input: ReadWalletBalancesInput): Promise<WalletBalancesBody> => ({
  chainId: input.chainId,
  owner: input.owner,
  agent: input.agent,
  wallets: await Promise.all(uniqueWallets(input).map((wallet) => snapshot(input.rpc, wallet, assetsFor(input)))),
});
