import { formatTokenAmount } from "./decimal.ts";
import { z } from "zod";

const cell = (value: unknown): string =>
  String(value ?? "").replaceAll("|", "\\|").replaceAll(/\r?\n/gu, " ");

export const markdownTable = (headers: readonly string[], rows: readonly (readonly unknown[])[]): string => {
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n");
  return body.length === 0 ? `${head}\n${divider}` : `${head}\n${divider}\n${body}`;
};

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  z.record(z.string(), z.unknown()).safeParse(value).success
    ? z.record(z.string(), z.unknown()).parse(value)
    : {};

const textAt = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
const boolAt = (value: unknown): string => value === true ? "true" : value === false ? "false" : textAt(value);

const tokenRow = (token: unknown): {
  readonly name: string; readonly symbol: string; readonly address: string; readonly decimals: number; readonly chainId: string;
} => {
  const parsed = z.object({
    name: z.string().optional(),
    symbol: z.string().optional(),
    address: z.string().optional(),
    decimals: z.number().int().optional(),
    chainId: z.union([z.number(), z.string()]).optional(),
  }).loose().safeParse(token);
  return {
    name: parsed.success ? parsed.data.name ?? "" : "",
    symbol: parsed.success ? parsed.data.symbol ?? "" : "",
    address: parsed.success ? parsed.data.address ?? "" : "",
    decimals: parsed.success ? parsed.data.decimals ?? 18 : 18,
    chainId: parsed.success ? String(parsed.data.chainId ?? "") : "",
  };
};

const timeInForceAt = (value: unknown): string => {
  if (typeof value === "string") return value;
  const parsed = record(value);
  const kind = textAt(parsed["kind"]);
  const expiresAt = textAt(parsed["expiresAt"]);
  if (kind.length === 0) return "";
  return expiresAt.length === 0 ? kind : `${kind} ${expiresAt}`;
};

const matchingCopy = (outcome: string): string => {
  if (outcome === "fillsNow") return "matches instantly";
  if (outcome === "rests") return "rests on the book";
  if (outcome === "unfillable") return "will not fill";
  return outcome;
};

const transactionRows = (body: Readonly<Record<string, unknown>>): (readonly unknown[])[] => {
  const prerequisites = record(body["prerequisites"]);
  const listed = z.array(z.record(z.string(), z.unknown())).safeParse(prerequisites["transactions"]);
  const calls = z.array(z.record(z.string(), z.unknown())).safeParse(body["calls"]);
  const lifecycle = record(body["lifecycle"]);
  const domain = record(lifecycle["domain"]);
  const rows: (readonly unknown[])[] = [];
  for (const transaction of listed.success ? listed.data : []) {
    rows.push(["prerequisite", transaction["to"], transaction["value"] ?? "0x0", transaction["data"]]);
  }
  for (const call of calls.success ? calls.data : []) {
    rows.push(["call", call["to"], call["value"] ?? "0x0", call["data"]]);
  }
  if (textAt(lifecycle["primaryType"]).length > 0) {
    rows.push(["lifecycle", domain["verifyingContract"] ?? lifecycle["primaryType"], "", lifecycle["primaryType"]]);
  }
  return rows;
};

const presentAmbiguous = (body: Readonly<Record<string, unknown>>): string => {
  const candidates = z.array(z.record(z.string(), z.unknown())).safeParse(body["candidates"]);
  const rows = (candidates.success ? candidates.data : []).map((candidate) => [
    candidate["symbol"], candidate["name"], candidate["address"], candidate["decimals"],
  ]);
  return [
    "## Ambiguous token",
    markdownTable(["error", "field"], [[body["error"], body["field"]]]),
    "",
    "## Candidates",
    markdownTable(["symbol", "name", "address", "decimals"], rows),
    "",
    "## Next",
    "Call `request_trade` again with a specific token address.",
  ].join("\n");
};

export const presentRequestTrade = (body: unknown): string => {
  const parsed = record(body);
  if (parsed["error"] === "ambiguousToken") return presentAmbiguous(parsed);
  const trade = record(parsed["normalizedTrade"]);
  const policy = record(trade["policy"]);
  const amount = record(trade["amount"]);
  const tokens = record(parsed["tokens"]);
  const sell = tokenRow(tokens["sell"]);
  const buy = tokenRow(tokens["buy"]);
  const matching = record(parsed["matching"]);
  const safety = record(parsed["safety"]);
  const execution = record(parsed["execution"]);
  const prerequisites = record(parsed["prerequisites"]);
  const fundingUnits = textAt(execution["fundingAmountUnits"], "0");
  let fundingAmount = fundingUnits;
  try { fundingAmount = formatTokenAmount(BigInt(fundingUnits), sell.decimals); } catch { /* keep raw */ }
  const wrap = prerequisites["wrapRequired"] === true;
  const checks = z.array(z.record(z.string(), z.unknown())).safeParse(safety["checks"]);
  const warnings = z.array(z.string()).safeParse(safety["warnings"]);
  const checkRows = (checks.success ? checks.data : []).map((check) => [
    check["name"], boolAt(check["safe"]), check["notes"] ?? check["severity"] ?? "",
  ]);
  const warningRows = (warnings.success ? warnings.data : []).map((warning) => [warning]);
  const recipient = textAt(trade["recipient"], textAt(parsed["recipient"]));
  const spot = record(parsed["spotPrice"]);
  const outcome = textAt(matching["outcome"]);
  return [
    "## Trade",
    markdownTable(
      ["policy", "timeInForce", "sell", "sellToken", "buy", "buyToken", "amountSide", "amount", "disposition", "matching", "expectedFill", "verdict"],
      [[
        policy["kind"], timeInForceAt(policy["timeInForce"]), sell.symbol, sell.address, buy.symbol, buy.address,
        amount["side"], amount["value"], parsed["disposition"], matchingCopy(outcome), matching["expectedFillPrice"], safety["verdict"],
      ]],
    ),
    "",
    "## Tokens",
    markdownTable(
      ["side", "name", "symbol", "decimals", "chainId", "address"],
      [
        ["sell", sell.name, sell.symbol, sell.decimals, sell.chainId, sell.address],
        ["buy", buy.name, buy.symbol, buy.decimals, buy.chainId, buy.address],
      ],
    ),
    "",
    "## Price",
    markdownTable(
      ["book", "expectedFill", "spotSell", "spotBuy", "currency", "observedAt"],
      [[matchingCopy(outcome), matching["expectedFillPrice"], spot["sell"], spot["buy"], spot["currency"], spot["observedAt"]]],
    ),
    "",
    "## Addresses",
    markdownTable(
      ["role", "address"],
      [
        ["owner", parsed["owner"]],
        ["agent", parsed["agent"]],
        ["vault", execution["vault"]],
        ["recipient", recipient],
      ],
    ),
    "",
    "## Funding",
    markdownTable(
      ["fundingAmount", "wrapRequired", "permit2ApprovalRequired", "agentSellToken", "agentNative"],
      [[fundingAmount, boolAt(prerequisites["wrapRequired"]), boolAt(prerequisites["permit2ApprovalRequired"]), sell.symbol, wrap ? "ETH" : ""]],
    ),
    "",
    "## Transactions",
    markdownTable(["kind", "to", "value", "data"], transactionRows(parsed)),
    "",
    "## Safety",
    markdownTable(["check", "safe", "notes"], checkRows),
    warningRows.length === 0 ? "" : `\n${markdownTable(["warning"], warningRows)}`,
    "",
    "## Next",
    markdownTable(["previewId", "previewHash"], [[parsed["previewId"], parsed["previewHash"]]]),
    "",
    "Call `post_trade` with these ids.",
  ].join("\n");
};

const hashList = (value: unknown): readonly string[] => {
  if (typeof value === "string" && value.length > 0) return [value];
  const parsed = z.array(z.string()).safeParse(value);
  return parsed.success ? parsed.data : [];
};

export const presentPostTrade = (body: unknown): string => {
  const parsed = record(body);
  if (typeof parsed["warning"] === "string") {
    return [
      "## Status",
      markdownTable(["warning", "previewId", "previewHash"], [[parsed["warning"], parsed["previewId"], parsed["previewHash"]]]),
    ].join("\n");
  }
  if (parsed["status"] === "awaiting_delegation") {
    return [
      "## Status",
      markdownTable(
        ["status", "previewId", "previewHash", "transactionHash"],
        [[parsed["status"], parsed["previewId"], parsed["previewHash"], parsed["transactionHash"]]],
      ),
      "",
      "## Next",
      textAt(parsed["next"], "Call `post_trade` again with the same previewId and previewHash."),
    ].join("\n");
  }
  const txRows: (readonly unknown[])[] = [
    ...hashList(parsed["tradeTransactionHash"]).map((hash) => ["trade", hash]),
    ...hashList(parsed["fundingTransactionHash"]).map((hash) => ["funding", hash]),
    ...hashList(parsed["prerequisiteTransactionHashes"]).map((hash) => ["prerequisite", hash]),
  ];
  const sections = [
    "## Status",
    markdownTable(["tradeId", "status"], [[parsed["tradeId"], parsed["status"]]]),
    "",
    "## Transactions",
    markdownTable(["kind", "hash"], txRows),
  ];
  const signing = record(parsed["clearSigning"]);
  if (Object.keys(signing).length > 0) {
    sections.push("", "## Clear Signing", markdownTable(["field", "value"], Object.entries(signing)));
  }
  if (parsed["status"] === "fundedActivationPending") {
    sections.push(
      "",
      "## Next",
      markdownTable(["previewId", "previewHash"], [[parsed["previewId"] ?? parsed["tradeId"], parsed["previewHash"]]]),
      "",
      "Call `post_trade` again with the same ids. Activation is not automatic.",
    );
  }
  if (typeof parsed["activationError"] === "string" && parsed["activationError"].length > 0) {
    sections.push("", "## Activation error", markdownTable(["error"], [[parsed["activationError"]]]));
  }
  return sections.join("\n");
};

export const presentTrades = (body: unknown): string => {
  const parsed = record(body);
  const items = z.array(z.record(z.string(), z.unknown())).safeParse(parsed["items"]);
  const rows = (items.success ? items.data : []).map((item) => [
    item["id"], item["status"], item["kind"], item["recordType"],
    item["sellToken"], item["buyToken"],
    item["lifecycleTransactionHash"] ?? item["transactionHash"] ?? "",
    item["occurredAt"],
  ]);
  return [
    "## Trades",
    markdownTable(["id", "status", "kind", "source", "sellToken", "buyToken", "transaction", "occurredAt"], rows),
    parsed["nextCursor"] === undefined || parsed["nextCursor"] === null ? "" : `\n${markdownTable(["nextCursor"], [[parsed["nextCursor"]]])}`,
  ].join("\n");
};

export const presentBalances = (body: unknown): string => {
  const parsed = record(body);
  const wallets = z.array(z.record(z.string(), z.unknown())).safeParse(parsed["wallets"]);
  const listed = wallets.success ? wallets.data : [];
  const addressRows = listed.map((wallet) => [wallet["role"], wallet["address"]]);
  const balanceRows: (readonly unknown[])[] = [];
  for (const wallet of listed) {
    const assets = z.array(z.record(z.string(), z.unknown())).safeParse(wallet["assets"]);
    for (const asset of assets.success ? assets.data : []) {
      balanceRows.push([wallet["address"], wallet["role"], asset["symbol"], asset["amount"], asset["units"], asset["token"]]);
    }
  }
  return [
    "## Accounts",
    markdownTable(
      ["role", "address"],
      [
        ["logged_in", parsed["owner"] ?? ""],
        ["trading", parsed["agent"] ?? ""],
      ],
    ),
    "",
    "## Addresses",
    markdownTable(["role", "address"], addressRows),
    "",
    "## Balances",
    markdownTable(["address", "role", "asset", "amount", "units", "token"], balanceRows),
  ].join("\n");
};

export const jsonable = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return z.array(z.unknown()).parse(value).map(jsonable);
  if (value !== null && typeof value === "object") {
    const object = z.record(z.string(), z.unknown()).parse(value);
    return Object.fromEntries(Object.entries(object).map(([key, item]: [string, unknown]) => [key, jsonable(item)]));
  }
  return value;
};

export const mcpResult = (body: unknown, text: string) => {
  const safe = jsonable(body);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: typeof safe === "object" && safe !== null ? z.record(z.string(), z.unknown()).parse(safe) : { result: safe },
  };
};
