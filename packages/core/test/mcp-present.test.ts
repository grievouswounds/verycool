import { describe, expect, test } from "bun:test";
import { markdownTable, presentBalances, presentPostTrade, presentRequestTrade, presentTrades } from "../src/mcp-present.ts";

const preview = {
  previewId: "11111111-1111-4111-8111-111111111111",
  previewHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  owner: "0x1111111111111111111111111111111111111111",
  agent: "0x2222222222222222222222222222222222222222",
  recipient: "0x1111111111111111111111111111111111111111",
  normalizedTrade: {
    sellToken: "0x019799b067422517212ce754f96d4faa6cc6a090",
    buyToken: "0x0bb3844e65962a303bc4cabdd4b742a324f2f570",
    amount: { side: "sell", value: "10" },
    policy: { kind: "market", timeInForce: "ioc" },
    recipient: "0x1111111111111111111111111111111111111111",
  },
  tokens: {
    sell: { name: "Aqua USD", symbol: "aUSD", address: "0x019799b067422517212ce754f96d4faa6cc6a090", decimals: 6, chainId: 11155111, nativeReference: false },
    buy: { name: "Aqua ETH", symbol: "aETH", address: "0x0bb3844e65962a303bc4cabdd4b742a324f2f570", decimals: 18, chainId: 11155111, nativeReference: false },
  },
  spotPrice: { currency: "USD", sell: "1", buy: "2000", observedAt: "2026-09-13T18:00:00.000Z", provider: "1inch" },
  disposition: "immediate",
  matching: { outcome: "fillsNow", expectedFillPrice: "0.5" },
  execution: { vault: "0x3333333333333333333333333333333333333333", fundingAmountUnits: "10000000", kind: "market" },
  prerequisites: {
    wrapRequired: true,
    permit2ApprovalRequired: true,
    transactions: [{ from: "0x2222222222222222222222222222222222222222", to: "0x5555555555555555555555555555555555555555", value: "0x0", data: "0xbeef" }],
  },
  safety: {
    verdict: "safe",
    safe: true,
    checks: [{ name: "agentBalance", safe: true, notes: "funded" }],
    warnings: ["Fiat spot price unavailable"],
  },
  lifecycle: { primaryType: "IntentAuthorization", domain: { name: "Aqua" }, types: {}, message: {} },
  calls: [{ to: "0x4444444444444444444444444444444444444444", data: "0xdead" }],
};

describe("markdownTable", () => {
  test("escapes pipes and newlines", () => {
    const table = markdownTable(["A", "B"], [["a|b", "line\nbreak"]]);
    expect(table).toContain("| A | B |");
    expect(table).toContain("a\\|b");
    expect(table).not.toContain("\nbreak");
    expect(table).toContain("line break");
  });
});

describe("presentRequestTrade", () => {
  test("renders compact tables with tokens, prices, and transaction data", () => {
    const text = presentRequestTrade(preview);
    expect(text).toContain("## Trade");
    expect(text).toContain("market");
    expect(text).toContain("aUSD");
    expect(text).toContain("aETH");
    expect(text).toContain("10");
    expect(text).toContain("immediate");
    expect(text).toContain("matches instantly");
    expect(text).toContain("0.5");
    expect(text).toContain("safe");
    expect(text).toContain("## Addresses");
    expect(text).toContain("0x1111111111111111111111111111111111111111");
    expect(text).toContain("0x2222222222222222222222222222222222222222");
    expect(text).toContain("0x3333333333333333333333333333333333333333");
    expect(text).toContain("## Funding");
    expect(text).toContain("10");
    expect(text).toContain("wrap");
    expect(text).toContain("## Tokens");
    expect(text).toContain("Aqua USD");
    expect(text).toContain("11155111");
    expect(text).toContain("## Price");
    expect(text).toContain("matches instantly");
    expect(text).toContain("2000");
    expect(text).toContain("## Transactions");
    expect(text).toContain("0xdead");
    expect(text).toContain("0xbeef");
    expect(text).toContain("IntentAuthorization");
    expect(text).toContain("## Safety");
    expect(text).toContain("agentBalance");
    expect(text).toContain("Fiat spot price unavailable");
    expect(text).toContain("## Next");
    expect(text).toContain("11111111-1111-4111-8111-111111111111");
    expect(text).toContain("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(text).toContain("post_trade");
  });

  test("formats object timeInForce and resting matching", () => {
    const text = presentRequestTrade({
      ...preview,
      normalizedTrade: {
        ...preview.normalizedTrade,
        policy: { kind: "limit", limitPrice: "1000", timeInForce: { kind: "gtc" } },
      },
      matching: { outcome: "rests", expectedFillPrice: "1000" },
      disposition: "resting",
    });
    expect(text).toContain("gtc");
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("rests on the book");
  });

  test("lists ambiguous token candidates", () => {
    const text = presentRequestTrade({
      error: "ambiguousToken",
      field: "sellToken",
      candidates: [
        { symbol: "USD|C", name: "USD Coin", address: "0xaaa", decimals: 6 },
      ],
    });
    expect(text).toContain("ambiguousToken");
    expect(text).toContain("sellToken");
    expect(text).toContain("USD\\|C");
    expect(text).toContain("USD Coin");
  });
});

describe("presentPostTrade", () => {
  test("renders status and transaction hashes", () => {
    const text = presentPostTrade({
      tradeId: "22222222-2222-4222-8222-222222222222",
      status: "broadcast",
      tradeTransactionHash: "0x1111",
      fundingTransactionHash: "0x2222",
      prerequisiteTransactionHashes: ["0x3333"],
      clearSigning: { isBlindSign: false, v: "1" },
    });
    expect(text).toContain("## Status");
    expect(text).toContain("broadcast");
    expect(text).toContain("22222222-2222-4222-8222-222222222222");
    expect(text).toContain("## Transactions");
    expect(text).toContain("0x1111");
    expect(text).toContain("0x2222");
    expect(text).toContain("0x3333");
    expect(text).toContain("## Clear Signing");
    expect(text).toContain("isBlindSign");
    expect(text).toContain("false");
  });

  test("renders awaiting_delegation continuation", () => {
    const text = presentPostTrade({
      status: "awaiting_delegation",
      previewId: "p",
      previewHash: "h",
      transactionHash: "0xabc",
      next: "Call post_trade again",
    });
    expect(text).toContain("awaiting_delegation");
    expect(text).toContain("post_trade");
    expect(text).toContain("0xabc");
  });

  test("renders hosted resting warning", () => {
    const text = presentPostTrade({
      warning: "Hosted demo fills are market orders.",
      previewId: "pid",
      previewHash: "phash",
    });
    expect(text).toContain("Hosted demo fills are market orders.");
    expect(text).toContain("pid");
    expect(text).toContain("phash");
  });

  test("tells Jam to retry post_trade when activation is still pending", () => {
    const text = presentPostTrade({
      tradeId: "94f9c3c7-069d-4fa6-bf47-e6ab8a2ccefd",
      previewId: "94f9c3c7-069d-4fa6-bf47-e6ab8a2ccefd",
      previewHash: "0xa084447d4688d328c856ed5eb838edfabcf61061efd2503199f2bf0d9c32ad46",
      status: "fundedActivationPending",
      activationError: "vault code not yet observed; call post_trade again with the same ids",
    });
    expect(text).toContain("## Next");
    expect(text).toContain("post_trade");
    expect(text).toContain("not automatic");
    expect(text).toContain("## Activation error");
    expect(text).toContain("vault code not yet observed");
  });
});

describe("presentTrades", () => {
  test("renders filterable trade rows", () => {
    const text = presentTrades({
      items: [{
        recordType: "aqua",
        id: "69cc31e0-500d-46da-ac0d-ce347fb33848",
        status: "broadcast",
        kind: "market",
        sellToken: "0x019799b067422517212ce754f96d4faa6cc6a090",
        buyToken: "0x0bb3844e65962a303bc4cabdd4b742a324f2f570",
        lifecycleTransactionHash: "0xf2689de9f0a4738879a6d0efbcdcc356ca07a3660127b6142c27662d8df1373d",
        occurredAt: "2026-09-13T18:38:01.479Z",
      }],
    });
    expect(text).toContain("## Trades");
    expect(text).toContain("broadcast");
    expect(text).toContain("market");
    expect(text).toContain("69cc31e0-500d-46da-ac0d-ce347fb33848");
    expect(text).toContain("0xf2689de9f0a4738879a6d0efbcdcc356ca07a3660127b6142c27662d8df1373d");
  });
});

describe("presentBalances", () => {
  test("lists wallets and assets", () => {
    const text = presentBalances({
      chainId: 11155111,
      owner: "0x1111111111111111111111111111111111111111",
      agent: "0x2222222222222222222222222222222222222222",
      wallets: [{
        role: "agent",
        address: "0x2222222222222222222222222222222222222222",
        assets: [{
          symbol: "ETH",
          token: "native",
          decimals: 18,
          units: "1000000000000000000",
          amount: "1",
        }],
      }],
    });
    expect(text).toContain("## Accounts");
    expect(text).toContain("logged_in");
    expect(text).toContain("0x1111111111111111111111111111111111111111");
    expect(text).toContain("trading");
    expect(text).toContain("0x2222222222222222222222222222222222222222");
    expect(text).toContain("## Addresses");
    expect(text).toContain("agent");
    expect(text).toContain("## Balances");
    expect(text).toContain("ETH");
    expect(text).toContain("1");
  });
});
