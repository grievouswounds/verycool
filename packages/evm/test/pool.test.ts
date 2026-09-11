import { z } from "zod";
import { describe, expect, test } from "bun:test";
import { AppError, addressSchema, hexSchema, quantitySchema } from "@aqua/core";
import { keccakHex, hexToBytes, initializeCubane } from "../src/index.ts";
import { PooledRpcClient, PooledRpcTransport, serveRpcProxy } from "../src/pool.ts";
import type { RpcEndpoint } from "../src/endpoints.ts";
import { ETHEREUM_SEPOLIA_CHAIN_ID, resolvePoolEndpoints } from "../src/endpoints.ts";
import { classifyJsonRpc } from "../src/normalize.ts";

const SEPOLIA = 11_155_111;
const chainIdHex = "0xaa36a7";
const rpcBodySchema = z.object({ id: z.number(), method: z.string(), params: z.array(z.unknown()) }).loose();
type RpcBody = z.infer<typeof rpcBodySchema>;

const endpoints = (...urls: readonly string[]): readonly RpcEndpoint[] =>
  urls.map((url, index) => ({ name: `n${String(index)}`, tier: 0, url }));

const success = (id: number, result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id, result });
const failure = (id: number, code: number, message: string, data?: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};
const requestBody = (init: RequestInit | undefined): string => {
  const body = init?.body;
  if (typeof body === "string") return body;
  throw new Error("RPC test fetcher expected a JSON string body");
};
const mustReject = async (run: () => Promise<unknown>, message?: string): Promise<void> => {
  let failed = false;
  try {
    await run();
  } catch (error: unknown) {
    failed = true;
    expect(error).toBeInstanceOf(AppError);
    if (message !== undefined) expect(error instanceof Error ? error.message : "").toBe(message);
  }
  expect(failed).toBe(true);
};

const clientOf = (
  urls: readonly string[],
  fetcher: (url: string, body: RpcBody) => Promise<Response> | Response,
  now: () => number = () => Date.now(),
): PooledRpcClient => new PooledRpcClient(new PooledRpcTransport(SEPOLIA, endpoints(...urls), {
  timeoutMs: 200,
  now,
  random: () => 0,
  fetcher: async (input, init) => {
    const body = rpcBodySchema.parse(JSON.parse(requestBody(init)));
    return fetcher(requestUrl(input), body);
  },
}));

describe("pooled RPC transport", () => {
  test("fails over a transport error and does not retry a revert", async () => {
    const calls: string[] = [];
    const rpc = clientOf(["http://a.test/", "http://b.test/"], (url, body) => {
      if (body.method === "eth_chainId") return success(body.id, chainIdHex);
      calls.push(`${url}${body.method}`);
      if (url === "http://a.test/" && body.method === "eth_gasPrice") {
        return Promise.reject(new Error("connect ECONNREFUSED"));
      }
      if (body.method === "eth_gasPrice") return success(body.id, "0x1");
      return success(body.id, "0x1");
    });
    expect(await rpc.gasPrice()).toBe(1n);
    expect(calls).toContain("http://a.test/eth_gasPrice");
    expect(calls).toContain("http://b.test/eth_gasPrice");

    const reverted: string[] = [];
    const reverting = clientOf(["http://a.test/", "http://b.test/"], (url, body) => {
      if (body.method === "eth_chainId") return success(body.id, chainIdHex);
      if (body.method === "eth_call") {
        reverted.push(url);
        return failure(body.id, -32_000, "execution reverted", "0x08c379a0");
      }
      return success(body.id, "0x");
    });
    await mustReject(async () => reverting.call({
      to: addressSchema.parse(`0x${"11".repeat(20)}`),
      data: hexSchema.parse("0x"),
    }));
    expect(reverted).toEqual(["http://a.test/"]);
  });

  test("opens a breaker, cools down, probes half-open, then closes", async () => {
    let now = 1_000;
    let calls = 0;
    const rpc = clientOf(["http://a.test/"], (_url, body) => {
      if (body.method === "eth_chainId") return success(body.id, chainIdHex);
      calls += 1;
      if (now < 50_000) return Promise.reject(new Error("timeout"));
      return success(body.id, "0x2");
    }, () => now);
    await mustReject(async () => rpc.gasPrice());
    await mustReject(async () => rpc.gasPrice());
    await mustReject(async () => rpc.gasPrice());
    const afterOpen = calls;
    await mustReject(async () => rpc.gasPrice());
    expect(calls).toBe(afterOpen);
    now += 120_000;
    expect(await rpc.gasPrice()).toBe(2n);
    expect(rpc.snapshot().open).toBe(0);
  });

  test("quarantines a wrong-chain endpoint on admission", async () => {
    const calls: string[] = [];
    const rpc = clientOf(["http://wrong.test/", "http://right.test/"], (url, body) => {
      if (body.method === "eth_chainId") {
        calls.push(url);
        return success(body.id, url.includes("wrong") ? "0x1" : chainIdHex);
      }
      calls.push(`${url}${body.method}`);
      return success(body.id, "0x3");
    });
    expect(await rpc.gasPrice()).toBe(3n);
    expect(calls.filter((item) => item.startsWith("http://wrong.test/") && item.includes("eth_gasPrice"))).toEqual([]);
    expect(rpc.snapshot().quarantined).toBe(1);
  });

  test("never asks a lagging endpoint for a range it cannot serve", async () => {
    const logs: string[] = [];
    const rpc = clientOf(["http://lag.test/", "http://tip.test/"], (url, body) => {
      if (body.method === "eth_chainId") return success(body.id, chainIdHex);
      if (body.method === "eth_blockNumber") return success(body.id, url.includes("lag") ? "0xa" : "0x14");
      if (body.method === "eth_getLogs") {
        logs.push(url);
        return success(body.id, []);
      }
      return success(body.id, "0x1");
    });
    await rpc.blockNumber();
    await rpc.logs({ fromBlock: 12n, toBlock: 15n, topics: [] });
    expect(logs).toEqual(["http://tip.test/"]);
  });

  test("maps already-known broadcast errors to the local transaction hash", async () => {
    initializeCubane();
    const raw = hexSchema.parse("0x02");
    const rpc = clientOf(["http://a.test/", "http://b.test/", "http://c.test/"], (_url, body) => {
      if (body.method === "eth_chainId") return success(body.id, chainIdHex);
      if (body.method === "eth_sendRawTransaction") return failure(body.id, -32_000, "already known");
      return success(body.id, "0x1");
    });
    expect(await rpc.sendRawTransaction(raw)).toBe(keccakHex(hexToBytes(raw)));
  });

  test("throws when every broadcast endpoint returns a terminal error", async () => {
    const raw = hexSchema.parse("0x02");
    const rpc = clientOf(["http://a.test/"], (_url, body) => {
      if (body.method === "eth_chainId") return success(body.id, chainIdHex);
      return failure(body.id, -32_600, "invalid request");
    });
    await mustReject(async () => rpc.sendRawTransaction(raw));
  });

  test("fails closed when no endpoint accepts state overrides", async () => {
    const rpc = clientOf(["http://a.test/", "http://b.test/"], (_url, body) => {
      if (body.method === "eth_chainId") return success(body.id, chainIdHex);
      if (body.method === "eth_call") return failure(body.id, -32_601, "method not found");
      return success(body.id, "0x");
    });
    const call = {
      to: addressSchema.parse(`0x${"11".repeat(20)}`),
      data: hexSchema.parse("0x"),
    };
    const overrides = { [`0x${"11".repeat(20)}`]: { balance: quantitySchema.parse("0x1") } };
    await mustReject(async () => rpc.call(call, overrides), "No RPC endpoint accepts eth_call state overrides");
    await mustReject(async () => rpc.call(call, overrides), "No RPC endpoint accepts eth_call state overrides");
  });

  test("session pins nonce read and broadcast to one endpoint", async () => {
    initializeCubane();
    const sendUrls: string[] = [];
    const rpc = clientOf(["http://a.test/", "http://b.test/", "http://c.test/"], (url, body) => {
      if (body.method === "eth_chainId") return success(body.id, chainIdHex);
      if (body.method === "eth_getTransactionCount") return success(body.id, "0x7");
      if (body.method === "eth_sendRawTransaction") {
        sendUrls.push(url);
        return success(body.id, `0x${"ab".repeat(32)}`);
      }
      return success(body.id, "0x1");
    });
    const session = rpc.session();
    await session.transactionCount(addressSchema.parse(`0x${"22".repeat(20)}`));
    await session.sendRawTransaction(hexSchema.parse("0x02"));
    expect(sendUrls).toEqual(["http://a.test/"]);
    await rpc.sendRawTransaction(hexSchema.parse("0x02"));
    expect(sendUrls.length).toBeGreaterThan(1);
  });

  test("serveRpcProxy fans out broadcasts and singles reads", async () => {
    initializeCubane();
    const sendUrls: string[] = [];
    const callUrls: string[] = [];
    const rpc = clientOf(["http://a.test/", "http://b.test/", "http://c.test/"], (url, body) => {
      if (body.method === "eth_chainId") return success(body.id, chainIdHex);
      if (body.method === "eth_sendRawTransaction") {
        sendUrls.push(url);
        return success(body.id, `0x${"ab".repeat(32)}`);
      }
      if (body.method === "eth_call") {
        callUrls.push(url);
        return success(body.id, "0x");
      }
      return success(body.id, "0x1");
    });
    const proxy = serveRpcProxy(rpc);
    try {
      const broadcast = await fetch(proxy.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x02"] }),
      });
      expect(broadcast.ok).toBe(true);
      expect(sendUrls.length).toBe(3);
      const call = await fetch(proxy.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "eth_call",
          params: [{ to: `0x${"11".repeat(20)}`, data: "0x" }, "latest"],
        }),
      });
      expect(call.ok).toBe(true);
      expect(callUrls).toHaveLength(1);
    } finally {
      proxy.stop();
    }
  });

  test("normalizes nested revert data", () => {
    const error = classifyJsonRpc("eth_call", [], -32_000, "execution reverted", { data: "0x08c379a0" });
    expect(error.class).toBe("executionReverted");
    expect(error.revertData).toBe("0x08c379a0");
    expect(error.retryable).toBe(false);
  });

  test("hedges a hung primary endpoint instead of waiting for its admission timeout", async () => {
    const rpc = new PooledRpcClient(new PooledRpcTransport(SEPOLIA, endpoints("http://slow.test/", "http://fast.test/"), {
      timeoutMs: 5_000,
      random: () => 0,
      fetcher: async (input, init) => {
        const url = requestUrl(input);
        const body = rpcBodySchema.parse(JSON.parse(requestBody(init)));
        if (url.includes("slow")) {
          await new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            }, { once: true });
          });
        }
        if (body.method === "eth_chainId") return success(body.id, chainIdHex);
        return success(body.id, "0x5");
      },
    }));
    expect(await rpc.gasPrice()).toBe(5n);
  });

  test("keeps the manifest RPC at the front of a registered chain pool without duplicating it", () => {
    const extra = "https://rpc.example.invalid/sepolia";
    const pooled = resolvePoolEndpoints(ETHEREUM_SEPOLIA_CHAIN_ID, extra);
    expect(pooled[0]).toEqual({ name: "manifest", tier: 0, url: extra });
    const publicnode = "https://ethereum-sepolia-rpc.publicnode.com";
    const existing = resolvePoolEndpoints(ETHEREUM_SEPOLIA_CHAIN_ID, publicnode);
    expect(existing[0]?.url).toBe(publicnode);
    expect(existing.filter((endpoint) => endpoint.url === publicnode)).toHaveLength(1);
  });
});
