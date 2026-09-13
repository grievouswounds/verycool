import { describe, expect, test } from "bun:test";
import type { Address, Hex, RpcCall } from "@aqua/core";
import { encodeBalanceOf } from "../src/abi.ts";
import { readWalletBalances } from "../src/wallet-balances.ts";

const owner = "0x1111111111111111111111111111111111111111" as Address;
const agent = "0x2222222222222222222222222222222222222222" as Address;
const wrapped = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" as Address;
const aUsd = "0x019799b067422517212ce754f96d4faa6cc6a090" as Address;
const aEth = "0x0bb3844e65962a303bc4cabdd4b742a324f2f570" as Address;

const encodeUint = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}` as Hex;

const stubRpc = (native: bigint, tokens: Readonly<Record<string, bigint>>) => ({
  async balance(_address: Address): Promise<bigint> {
    return native;
  },
  async call(transaction: RpcCall): Promise<Hex> {
    const units = tokens[transaction.to];
    if (units === undefined) throw new Error(`unexpected token ${transaction.to}`);
    expect(transaction.data.startsWith("0x")).toBe(true);
    expect(encodeBalanceOf(agent).slice(0, 10)).toBe(transaction.data.slice(0, 10));
    return encodeUint(units);
  },
});

describe("readWalletBalances", () => {
  test("reads native, wrapped, and fixture tokens", async () => {
    const body = await readWalletBalances({
      rpc: stubRpc(1_000_000_000_000_000_000n, {
        [wrapped]: 2n * 10n ** 18n,
        [aUsd]: 5_000_000n,
        [aEth]: 0n,
      }),
      chainId: 11_155_111,
      wrappedNative: { address: wrapped, symbol: "WETH", decimals: 18 },
      fixtures: [
        { address: aUsd, symbol: "aUSD", decimals: 6 },
        { address: aEth, symbol: "aETH", decimals: 18 },
      ],
      owner,
      agent,
    });
    expect(body.chainId).toBe(11_155_111);
    expect(body.owner).toBe(owner);
    expect(body.agent).toBe(agent);
    expect(body.wallets.map((wallet) => wallet.role)).toEqual(["owner", "agent"]);
    expect(body.wallets.map((wallet) => wallet.address)).toEqual([owner, agent]);
    const assets = body.wallets[1]?.assets ?? [];
    expect(assets.map((asset) => asset.symbol)).toEqual(["ETH", "WETH", "aUSD", "aETH"]);
    expect(assets[0]).toEqual({ symbol: "ETH", token: "native", decimals: 18, units: "1000000000000000000", amount: "1" });
    expect(assets[1]?.amount).toBe("2");
    expect(assets[2]?.amount).toBe("5");
    expect(assets[3]?.amount).toBe("0");
  });

  test("dedupes wrapped native when it is also a fixture", async () => {
    const body = await readWalletBalances({
      rpc: stubRpc(0n, { [wrapped]: 1n }),
      chainId: 31_337,
      wrappedNative: { address: wrapped, symbol: "WETH", decimals: 18 },
      fixtures: [{ address: wrapped, symbol: "WETH", decimals: 18 }],
      owner: null,
      agent,
    });
    expect(body.owner).toBeNull();
    expect(body.agent).toBe(agent);
    expect(body.wallets).toHaveLength(1);
    expect(body.wallets[0]?.assets.map((asset) => asset.symbol)).toEqual(["ETH", "WETH"]);
  });
});
