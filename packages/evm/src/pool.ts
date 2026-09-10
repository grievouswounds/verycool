import { z } from "zod";
import { hashSchema, hexSchema, quantitySchema, upstreamError } from "@aqua/core";
import type { RpcPort } from "@aqua/core";
import { hexToBytes, hexToQuantity, keccakHex } from "./hex.ts";
import type { RpcEndpoint } from "./endpoints.ts";
import { resolvePoolEndpoints } from "./endpoints.ts";
import { HealthBook } from "./health.ts";
import type { RpcPoolSnapshot } from "./health.ts";
import { ClassifiedRpcError, classifyTransport, isTerminalClass } from "./normalize.ts";
import { HttpRpcTransport, JsonRpcClient } from "./rpc.ts";
import type { Fetch, RpcRequestOptions, RpcTransport } from "./rpc.ts";

export type { RpcPoolSnapshot };

const QUORUM = 3;
const BROADCAST_FANOUT = 3;
const HEDGE_WAVE = 3;
const HEDGEABLE = new Set([
  "eth_chainId", "eth_gasPrice", "eth_blockNumber", "eth_getCode",
  "eth_getTransactionCount", "eth_getBalance", "eth_getBlockByNumber", "eth_maxPriorityFeePerGas",
]);

export interface PooledRpcOptions {
  readonly timeoutMs: number;
  readonly fetcher?: Fetch;
  readonly now?: () => number;
  readonly random?: () => number;
}

interface RankedEndpoint {
  readonly endpoint: RpcEndpoint;
  readonly transport: HttpRpcTransport;
}

const parseHeight = (method: string, result: unknown): bigint | undefined => {
  if (method !== "eth_blockNumber") return undefined;
  const parsed = quantitySchema.safeParse(result);
  if (!parsed.success) return undefined;
  return hexToQuantity(parsed.data);
};

export class PooledRpcTransport implements RpcTransport {
  private readonly chainId: number;
  private readonly endpoints: readonly RankedEndpoint[];
  private readonly health: HealthBook;
  private readonly random: () => number;
  private readonly admissions = new Map<string, Promise<boolean>>();

  public constructor(
    chainId: number,
    endpoints: readonly RpcEndpoint[],
    options: PooledRpcOptions,
  ) {
    this.chainId = chainId;
    this.random = options.random ?? Math.random;
    const fetcher = options.fetcher ?? fetch;
    this.endpoints = endpoints.map((endpoint) => ({
      endpoint,
      transport: new HttpRpcTransport(new URL(endpoint.url), options.timeoutMs, fetcher),
    }));
    this.health = new HealthBook(endpoints, options.now ?? Date.now, this.random);
  }

  public snapshot(): RpcPoolSnapshot {
    return this.health.snapshot();
  }

  public pin(): RpcTransport {
    return new PinnedRpcTransport(this);
  }

  public async request(method: string, params: readonly unknown[], options?: RpcRequestOptions): Promise<unknown> {
    if (method === "eth_blockNumber") return this.blockNumber();
    if (options?.kind === "broadcast" && method === "eth_sendRawTransaction") {
      return this.broadcast(params);
    }
    if (options?.requiresStateOverrides === true && !this.hasOverrideCandidate()) {
      throw upstreamError("No RPC endpoint accepts eth_call state overrides");
    }
    const ranked = this.rank(options, method);
    if (ranked.length === 0) throw upstreamError("No healthy RPC endpoints");
    if (HEDGEABLE.has(method) && options?.kind !== "broadcast") {
      return this.invokeHedged(ranked, method, params, options);
    }
    let last: ClassifiedRpcError | undefined;
    for (const candidate of ranked) {
      try {
        return await this.invoke(candidate, method, params, options);
      } catch (error: unknown) {
        if (!(error instanceof ClassifiedRpcError)) throw error;
        last = error;
        if (isTerminalClass(error.class) || error.class === "alreadyKnown") throw error;
      }
    }
    if (options?.requiresStateOverrides === true && !this.hasOverrideCandidate()) {
      throw upstreamError("No RPC endpoint accepts eth_call state overrides");
    }
    throw last ?? classifyTransport(new Error("RPC pool exhausted"));
  }

  public async invokeOn(
    url: string,
    method: string,
    params: readonly unknown[],
    options?: RpcRequestOptions,
  ): Promise<unknown> {
    const candidate = this.endpoints.find((item) => item.endpoint.url === url);
    if (candidate === undefined) throw classifyTransport(new Error("Pinned RPC endpoint is unknown"));
    return this.invoke(candidate, method, params, options);
  }

  public rankedUrls(options?: RpcRequestOptions, method = "eth_call"): readonly string[] {
    return this.rank(options, method).map((item) => item.endpoint.url);
  }

  private hasOverrideCandidate(): boolean {
    return this.endpoints.some((item) => {
      const state = this.health.get(item.endpoint.url);
      if (state.quarantined) return false;
      return state.capabilities.stateOverrides !== false;
    });
  }

  private async blockNumber(): Promise<unknown> {
    const ranked = this.rank(undefined, "eth_blockNumber");
    const needed = Math.min(QUORUM, ranked.length);
    if (needed === 0) throw upstreamError("No healthy RPC endpoints");
    const heights: bigint[] = [];
    let last: ClassifiedRpcError | undefined;
    for (let offset = 0; offset < ranked.length && heights.length < needed; offset += HEDGE_WAVE) {
      const wave = ranked.slice(offset, offset + HEDGE_WAVE);
      const settled = await Promise.all(wave.map(async (candidate) => {
        try {
          return { ok: true as const, result: await this.invoke(candidate, "eth_blockNumber", []) };
        } catch (error: unknown) {
          if (!(error instanceof ClassifiedRpcError)) throw error;
          return { ok: false as const, error };
        }
      }));
      for (const item of settled) {
        if (!item.ok) {
          last = item.error;
          continue;
        }
        const height = parseHeight("eth_blockNumber", item.result);
        if (height !== undefined) heights.push(height);
      }
    }
    if (heights.length === 0) throw last ?? classifyTransport(new Error("RPC pool exhausted"));
    heights.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const median = heights[Math.floor((heights.length - 1) / 2)];
    if (median === undefined) throw classifyTransport(new Error("RPC pool exhausted"));
    return `0x${median.toString(16)}`;
  }

  private async broadcast(params: readonly unknown[]): Promise<unknown> {
    const raw = hexSchema.parse(params[0]);
    const ranked = this.rank({ kind: "broadcast" }, "eth_sendRawTransaction").slice(0, BROADCAST_FANOUT);
    if (ranked.length === 0) throw upstreamError("No healthy RPC endpoints");
    const settled = await Promise.all(ranked.map(async (candidate) => {
      try {
        return { ok: true as const, value: await this.invoke(candidate, "eth_sendRawTransaction", params, { kind: "broadcast" }) };
      } catch (error: unknown) {
        if (!(error instanceof ClassifiedRpcError)) throw error;
        return { ok: false as const, error };
      }
    }));
    for (const item of settled) {
      if (item.ok) return hashSchema.parse(item.value);
    }
    const failures = settled.flatMap((item) => item.ok ? [] : [item.error]);
    if (failures.some((error) => error.class === "alreadyKnown")) {
      return keccakHex(hexToBytes(raw));
    }
    const terminal = failures.find((error) => isTerminalClass(error.class));
    if (terminal !== undefined) throw terminal;
    throw failures[0] ?? classifyTransport(new Error("RPC broadcast failed"));
  }

  private rank(options: RpcRequestOptions | undefined, method: string): readonly RankedEndpoint[] {
    const eligible: { readonly candidate: RankedEndpoint; readonly latency: number }[] = [];
    for (const candidate of this.endpoints) {
      const state = this.health.get(candidate.endpoint.url);
      if (state.quarantined) continue;
      if (!this.health.canSelect(candidate.endpoint.url)) continue;
      if (options?.requiresStateOverrides === true && state.capabilities.stateOverrides === false) continue;
      if (method === "eth_maxPriorityFeePerGas" && state.capabilities.maxPriorityFeePerGas === false) continue;
      if (options?.requiresHeight !== undefined && state.height !== null && state.height < options.requiresHeight) continue;
      if (options?.maxLogSpan !== undefined && state.capabilities.maxLogRange !== null && options.maxLogSpan > state.capabilities.maxLogRange) continue;
      eligible.push({ candidate, latency: state.ewmaLatencyMs ?? 0 });
    }
    eligible.sort((left, right) => {
      const tier = left.candidate.endpoint.tier - right.candidate.endpoint.tier;
      if (tier !== 0) return tier;
      const jitter = (this.random() - 0.5) * 5;
      return left.latency + jitter - (right.latency + (this.random() - 0.5) * 5);
    });
    return eligible.map((item) => item.candidate);
  }

  private async invokeHedged(
    ranked: readonly RankedEndpoint[],
    method: string,
    params: readonly unknown[],
    options?: RpcRequestOptions,
  ): Promise<unknown> {
    let last: ClassifiedRpcError | undefined;
    for (let offset = 0; offset < ranked.length; offset += HEDGE_WAVE) {
      const wave = ranked.slice(offset, offset + HEDGE_WAVE);
      const outcome = await new Promise<{ ok: true; value: unknown } | { ok: false; terminal: boolean }>((resolve, reject) => {
        let remaining = wave.length;
        let settled = false;
        for (const candidate of wave) {
          void this.invoke(candidate, method, params, options).then((value) => {
            if (settled) return;
            settled = true;
            resolve({ ok: true, value });
          }, (error: unknown) => {
            if (!(error instanceof ClassifiedRpcError)) {
              if (!settled) {
                settled = true;
                reject(error);
              }
              return;
            }
            last = error;
            if (isTerminalClass(error.class) || error.class === "alreadyKnown") {
              if (!settled) {
                settled = true;
                resolve({ ok: false, terminal: true });
              }
              return;
            }
            remaining -= 1;
            if (remaining === 0 && !settled) {
              settled = true;
              resolve({ ok: false, terminal: false });
            }
          });
        }
      });
      if (outcome.ok) return outcome.value;
      if (outcome.terminal) throw last ?? classifyTransport(new Error("RPC pool exhausted"));
    }
    throw last ?? classifyTransport(new Error("RPC pool exhausted"));
  }

  private async ensureAdmitted(candidate: RankedEndpoint): Promise<boolean> {
    const url = candidate.endpoint.url;
    const existing = this.admissions.get(url);
    if (existing !== undefined) return existing;
    const probe = (async () => {
      const started = Date.now();
      try {
        const result = await candidate.transport.request("eth_chainId", []);
        const chainId = Number(hexToQuantity(quantitySchema.parse(result)));
        this.health.admit(url, this.chainId, chainId);
        this.health.recordSuccess(url, Date.now() - started);
        return this.health.get(url).admitted;
      } catch (error: unknown) {
        if (error instanceof ClassifiedRpcError) this.health.recordFailure(url, error);
        else this.health.recordFailure(url, classifyTransport(error));
        return false;
      }
    })();
    this.admissions.set(url, probe);
    const admitted = await probe;
    if (!admitted) this.admissions.delete(url);
    return admitted;
  }

  private async invoke(
    candidate: RankedEndpoint,
    method: string,
    params: readonly unknown[],
    options?: RpcRequestOptions,
  ): Promise<unknown> {
    if (!this.health.beginProbe(candidate.endpoint.url)) {
      throw classifyTransport(new Error("RPC endpoint circuit is open"));
    }
    if (!await this.ensureAdmitted(candidate)) {
      throw classifyTransport(new Error("RPC endpoint failed chain-id admission"));
    }
    const started = Date.now();
    try {
      const result = await candidate.transport.request(method, params);
      if (method === "eth_getBlockByNumber" && result === null && options?.requiresHeight !== undefined) {
        throw classifyTransport(new Error("RPC claimed a block height it cannot serve"));
      }
      const height = parseHeight(method, result);
      this.health.recordSuccess(candidate.endpoint.url, Date.now() - started, height);
      if (options?.requiresStateOverrides === true) this.health.learnStateOverrides(candidate.endpoint.url, true);
      return result;
    } catch (error: unknown) {
      const classified = error instanceof ClassifiedRpcError ? error : classifyTransport(error);
      this.health.recordFailure(candidate.endpoint.url, classified);
      if (classified.class === "unsupportedMethod") {
        this.health.learnUnsupported(candidate.endpoint.url, method, options?.requiresStateOverrides === true);
      }
      if (classified.class === "rangeTooLarge" && options?.maxLogSpan !== undefined) {
        this.health.learnMaxLogRange(candidate.endpoint.url, options.maxLogSpan);
      }
      throw classified;
    }
  }
}

class PinnedRpcTransport implements RpcTransport {
  private current: string | undefined;
  private readonly pool: PooledRpcTransport;

  public constructor(pool: PooledRpcTransport) {
    this.pool = pool;
  }

  public async request(method: string, params: readonly unknown[], options?: RpcRequestOptions): Promise<unknown> {
    const urls = this.pool.rankedUrls(options, method);
    const ordered = this.current === undefined ? urls : [this.current, ...urls.filter((url) => url !== this.current)];
    if (ordered.length === 0) throw upstreamError("No healthy RPC endpoints");
    let last: ClassifiedRpcError | undefined;
    for (const url of ordered) {
      try {
        const result = await this.pool.invokeOn(url, method, params, options);
        this.current = url;
        return result;
      } catch (error: unknown) {
        if (!(error instanceof ClassifiedRpcError)) throw error;
        last = error;
        if (isTerminalClass(error.class) || error.class === "alreadyKnown") {
          if (error.class === "alreadyKnown" && method === "eth_sendRawTransaction") {
            const raw = hexSchema.parse(params[0]);
            return keccakHex(hexToBytes(raw));
          }
          throw error;
        }
      }
    }
    throw last ?? classifyTransport(new Error("RPC pool exhausted"));
  }
}

export class PooledRpcClient extends JsonRpcClient {
  private readonly pooled: PooledRpcTransport;

  public constructor(transport: PooledRpcTransport) {
    super(transport);
    this.pooled = transport;
  }

  public session(): RpcPort {
    return new JsonRpcClient(this.pooled.pin());
  }

  public snapshot(): RpcPoolSnapshot {
    return this.pooled.snapshot();
  }

  public async rawRequest(method: string, params: readonly unknown[], options?: RpcRequestOptions): Promise<unknown> {
    return this.pooled.request(method, params, options);
  }
}

export const createPooledRpcClient = (
  chain: { readonly id: number; readonly rpcUrl: string },
  timeoutMs: number,
  fetcher?: Fetch,
  extras?: { readonly now?: () => number; readonly random?: () => number },
): PooledRpcClient => {
  const endpoints = resolvePoolEndpoints(chain.id, chain.rpcUrl);
  return new PooledRpcClient(new PooledRpcTransport(chain.id, endpoints, {
    timeoutMs,
    ...(fetcher === undefined ? {} : { fetcher }),
    ...(extras?.now === undefined ? {} : { now: extras.now }),
    ...(extras?.random === undefined ? {} : { random: extras.random }),
  }));
};

export const serveRpcProxy = (client: PooledRpcClient): { readonly url: string; stop: () => void } => {
  const bodySchema = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string()]),
    method: z.string().min(1),
    params: z.array(z.unknown()).optional(),
  }).strict();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const parsed = bodySchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32_600, message: "Invalid request" } }, { status: 400 });
      }
      try {
        const options = parsed.data.method === "eth_sendRawTransaction" ? { kind: "broadcast" as const } : undefined;
        const result = await client.rawRequest(parsed.data.method, parsed.data.params ?? [], options);
        return Response.json({ jsonrpc: "2.0", id: parsed.data.id, result });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "RPC failed";
        return Response.json({ jsonrpc: "2.0", id: parsed.data.id, error: { code: -32_000, message } });
      }
    },
  });
  return { url: `http://127.0.0.1:${String(server.port)}`, stop: () => { void server.stop(); } };
};
