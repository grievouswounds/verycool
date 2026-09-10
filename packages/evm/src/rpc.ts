import { z } from "zod";
import { addressSchema, hashSchema, hexSchema, quantitySchema, upstreamError } from "@aqua/core";
import type { Address, Hash, Hex, RpcBlock, RpcCall, RpcLog, RpcLogFilter, RpcPort, RpcReceipt, RpcStateOverrides } from "@aqua/core";
import { selector } from "./hex.ts";
import { decodeString, decodeUint256 } from "./abi.ts";
import { hexToQuantity, quantityToHex } from "./hex.ts";

const rpcSuccessSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.unknown() }).strict();
const rpcFailureSchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.number(),
  error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).strict(),
}).strict();
const rawBlockSchema = z.object({ number: quantitySchema, hash: hashSchema, timestamp: quantitySchema }).loose();
const rawLogSchema = z.object({
  address: addressSchema, blockNumber: quantitySchema, blockHash: hashSchema,
  transactionHash: hashSchema, logIndex: quantitySchema, data: hexSchema,
  topics: z.array(hashSchema).min(1).max(4), removed: z.literal(false).optional(),
}).loose();
const rawReceiptSchema = z.object({ transactionHash: hashSchema, blockNumber: quantitySchema, status: z.enum(["0x0", "0x1"]) }).loose().nullable();

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class JsonRpcClient implements RpcPort {
  private requestId = 0;
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly fetcher: Fetch;

  public constructor(
    url: URL,
    timeoutMs: number,
    fetcher: Fetch = fetch,
  ) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.fetcher = fetcher;
  }

  private async request(method: string, params: readonly unknown[]): Promise<unknown> {
    const id = ++this.requestId;
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "aqua-json-rpc/1" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause: unknown) {
      throw upstreamError(cause instanceof Error ? cause.message : "RPC transport failed");
    }
    if (!response.ok) throw upstreamError(`RPC returned HTTP ${String(response.status)}`);
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]{0,7})$/u.test(declared) || Number(declared) > 1_048_576)) {
      throw upstreamError("RPC response Content-Length is invalid or too large");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 1_048_576) throw upstreamError("RPC response exceeds 1 MiB");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw upstreamError("RPC response is not valid UTF-8"); }
    let body: unknown;
    try { body = JSON.parse(text) as unknown; }
    catch { throw upstreamError("RPC response is not valid JSON"); }
    const failed = rpcFailureSchema.safeParse(body);
    if (failed.success) {
      const data = failed.data.error.data;
      const detail = typeof data === "string" && data.length > 0 ? ` data=${data}` : "";
      throw upstreamError(`RPC ${String(failed.data.error.code)}: ${failed.data.error.message}${detail}`);
    }
    const parsed = rpcSuccessSchema.safeParse(body);
    if (!parsed.success || parsed.data.id !== id) throw upstreamError("Malformed or mismatched RPC response");
    return parsed.data.result;
  }

  public async chainId(): Promise<number> {
    const value = quantitySchema.parse(await this.request("eth_chainId", []));
    const chainId = hexToQuantity(value);
    if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw upstreamError("chainId exceeds safe integer range");
    return Number(chainId);
  }

  public async getCode(address: Address): Promise<Hex> {
    return hexSchema.parse(await this.request("eth_getCode", [address, "latest"]));
  }

  public async call(transaction: RpcCall, overrides?: RpcStateOverrides): Promise<Hex> {
    const params: unknown[] = [this.toRpcTransaction(transaction), "latest"];
    if (overrides !== undefined) params.push(this.toRpcOverrides(overrides));
    return hexSchema.parse(await this.request("eth_call", params));
  }

  public async estimateGas(transaction: RpcCall, overrides?: RpcStateOverrides): Promise<bigint> {
    const params: unknown[] = [this.toRpcTransaction(transaction)];
    if (overrides !== undefined) params.push("latest", this.toRpcOverrides(overrides));
    return hexToQuantity(quantitySchema.parse(await this.request("eth_estimateGas", params)));
  }

  public async tokenDecimals(address: Address): Promise<number> {
    const value = decodeUint256(await this.call({ to: address, data: selector("decimals()") }));
    if (value > 255n) throw upstreamError("Token decimals exceeds uint8 range");
    return Number(value);
  }

  public async tokenSymbol(address: Address): Promise<string | null> {
    try {
      const symbol = decodeString(await this.call({ to: address, data: selector("symbol()") })).normalize("NFC");
      return symbol.length > 0 && Array.from(symbol).length <= 32 && !/\p{Cc}/u.test(symbol) ? symbol : null;
    } catch {
      return null;
    }
  }

  public async tokenName(address: Address): Promise<string | null> {
    try {
      const name = decodeString(await this.call({ to: address, data: selector("name()") })).normalize("NFC");
      return name.length > 0 && Array.from(name).length <= 128 && !/\p{Cc}/u.test(name) ? name : null;
    } catch {
      return null;
    }
  }

  public async blockNumber(): Promise<bigint> {
    return hexToQuantity(quantitySchema.parse(await this.request("eth_blockNumber", [])));
  }

  public async block(number: bigint): Promise<RpcBlock> {
    const parsed = rawBlockSchema.parse(await this.request("eth_getBlockByNumber", [quantityToHex(number), false]));
    return { number: hexToQuantity(parsed.number), hash: parsed.hash, timestamp: hexToQuantity(parsed.timestamp) };
  }

  public async logs(filter: RpcLogFilter): Promise<readonly RpcLog[]> {
    const requestFilter: Record<string, unknown> = {
      fromBlock: quantityToHex(filter.fromBlock), toBlock: quantityToHex(filter.toBlock), topics: filter.topics,
    };
    if (filter.address !== undefined) requestFilter["address"] = filter.address;
    const raw = z.array(rawLogSchema).parse(await this.request("eth_getLogs", [requestFilter]));
    return raw.map((item) => ({
      address: item.address, blockNumber: hexToQuantity(item.blockNumber), blockHash: item.blockHash,
      transactionHash: item.transactionHash, logIndex: hexToQuantity(item.logIndex),
      data: item.data, topics: item.topics,
    }));
  }

  public async transactionCount(address: Address): Promise<bigint> {
    return hexToQuantity(quantitySchema.parse(await this.request("eth_getTransactionCount", [address, "pending"])));
  }

  public async balance(address: Address): Promise<bigint> {
    return hexToQuantity(quantitySchema.parse(await this.request("eth_getBalance", [address, "latest"])));
  }

  public async gasPrice(): Promise<bigint> {
    return hexToQuantity(quantitySchema.parse(await this.request("eth_gasPrice", [])));
  }

  public async maxPriorityFeePerGas(): Promise<bigint> {
    return hexToQuantity(quantitySchema.parse(await this.request("eth_maxPriorityFeePerGas", [])));
  }

  public async sendRawTransaction(transaction: Hex): Promise<Hash> {
    return hashSchema.parse(await this.request("eth_sendRawTransaction", [transaction]));
  }

  public async transactionReceipt(hash: Hash): Promise<RpcReceipt | null> {
    const receipt = rawReceiptSchema.parse(await this.request("eth_getTransactionReceipt", [hash]));
    return receipt === null ? null : {
      transactionHash: receipt.transactionHash, blockNumber: hexToQuantity(receipt.blockNumber),
      status: receipt.status === "0x1" ? "success" : "reverted",
    };
  }

  private toRpcTransaction(transaction: RpcCall): Readonly<Record<string, string>> {
    const value: Record<string, string> = { to: addressSchema.parse(transaction.to), data: transaction.data };
    if (transaction.from !== undefined) value["from"] = transaction.from;
    if (transaction.value !== undefined) value["value"] = transaction.value;
    return value;
  }

  private toRpcOverrides(overrides: RpcStateOverrides): Readonly<Record<string, unknown>> {
    return Object.fromEntries(Object.entries(overrides).map(([address, override]) => {
      const body: Record<string, unknown> = {};
      if (override.balance !== undefined) body["balance"] = override.balance;
      if (override.nonce !== undefined) body["nonce"] = override.nonce;
      if (override.code !== undefined) body["code"] = override.code;
      if (override.stateDiff !== undefined) body["stateDiff"] = override.stateDiff;
      return [address, body];
    }));
  }
}

export { quantityToHex };
