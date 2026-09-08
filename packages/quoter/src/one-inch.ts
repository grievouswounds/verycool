import { AppError, parseStrictJson } from "@aqua/core";
import type { Address } from "@aqua/core";
import { z } from "zod";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const spotPriceSchema = z.record(z.string(), z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u));
const tokenSchema = z.object({
  address: z.string(), symbol: z.string().min(1).max(64), name: z.string().min(1).max(256),
  decimals: z.number().int().min(0).max(255),
}).loose();
const tokenSearchSchema = z.array(tokenSchema);

export interface OneInchClientConfiguration {
  readonly apiKey: string;
  readonly baseUrl: URL;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly fetcher?: Fetch;
}

export interface TokenSearchResult {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

export class OneInchPriceClient {
  private readonly apiKey: string;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly fetcher: Fetch;

  public constructor(configuration: OneInchClientConfiguration) {
    this.apiKey = configuration.apiKey;
    this.baseUrl = configuration.baseUrl;
    this.timeoutMs = configuration.timeoutMs ?? 10_000;
    this.maximumResponseBytes = configuration.maximumResponseBytes ?? 1_048_576;
    this.fetcher = configuration.fetcher ?? fetch;
  }

  private async request(path: string, parameters: Readonly<Record<string, string>>): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause: unknown) {
      const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
      throw new AppError(timedOut ? 504 : 502, "urn:aqua:error:price-upstream", timedOut ? "Price upstream timed out" : "Price upstream transport failed");
    }
    if (!response.ok) {
      const status = response.status === 404 ? 404 : response.status === 429 ? 429 : 502;
      throw new AppError(status, "urn:aqua:error:price-upstream", `Price upstream returned HTTP ${String(response.status)}`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]{0,7})$/u.test(declared) || Number(declared) > this.maximumResponseBytes)) {
      throw new AppError(502, "urn:aqua:error:price-upstream", "Price upstream response length is invalid or too large");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > this.maximumResponseBytes) throw new AppError(502, "urn:aqua:error:price-upstream", "Price upstream response is too large");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new AppError(502, "urn:aqua:error:price-upstream", "Price upstream response is not valid UTF-8"); }
    try { return parseStrictJson(text); }
    catch { throw new AppError(502, "urn:aqua:error:price-upstream", "Price upstream response is not valid JSON"); }
  }

  public async price(chainId: number, address: Address, currency: string): Promise<string> {
    const body = spotPriceSchema.safeParse(await this.request(`/price/v1.1/${String(chainId)}/${address}`, { currency }));
    if (!body.success) throw new AppError(502, "urn:aqua:error:price-upstream", "Price upstream returned an invalid price response");
    const match = Object.entries(body.data).find(([candidate]) => candidate.toLowerCase() === address);
    if (match === undefined) throw new AppError(404, "urn:aqua:error:price-not-found", "No price was returned for the requested token");
    return match[1];
  }

  public async search(chainId: number, query: string): Promise<TokenSearchResult> {
    const body = tokenSearchSchema.safeParse(await this.request(`/token/v1.4/${String(chainId)}/search`, {
      query, limit: "1", ignore_listed: "false",
    }));
    if (!body.success) throw new AppError(502, "urn:aqua:error:price-upstream", "Price upstream returned an invalid token response");
    const token = body.data[0];
    if (token === undefined) throw new AppError(404, "urn:aqua:error:token-not-found", "No token matched the requested name");
    return token;
  }
}
