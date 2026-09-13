import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { DEFAULT_MAX_RESPONSE_BYTES, readBoundedJson } from "@aqua/core";
import { z } from "zod";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type HexAddress = `0x${string}`;
type HexSignature = `0x${string}`;

export type TypedDataRequest = Readonly<Record<string, unknown>> & {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, unknown>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
};

export interface X402Signer {
  readonly address: HexAddress;
  signTypedData(request: TypedDataRequest): Promise<HexSignature>;
}

export interface PaymentHeaderFactory {
  create(required: PaymentRequired, network: `eip155:${string}`): Promise<Readonly<Record<string, string>>>;
}

const evmAddressSchema = z.custom<HexAddress>((value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value));

const requirementsForNetwork = (requirements: PaymentRequirements[], network: `eip155:${string}`): PaymentRequirements[] =>
  requirements.filter((item) => item.network === network && item.scheme === "exact" &&
    item.extra["assetTransferMethod"] === "permit2" && item.extra["paymentFlow"] === "upfront");

export class LedgerX402PaymentHeaders implements PaymentHeaderFactory {
  readonly #signer: X402Signer;
  constructor(signer: X402Signer) { this.#signer = { ...signer, address: evmAddressSchema.parse(signer.address) }; }

  async create(required: PaymentRequired, network: `eip155:${string}`): Promise<Readonly<Record<string, string>>> {
    const client = new x402Client();
    client.registerPolicy((_version, requirements) => {
      const allowed = requirementsForNetwork(requirements, network);
      if (allowed.length === 0) throw new Error("x402 challenge has no allowed aqua payment requirement");
      return allowed;
    });
    client.setSpendControls(false);
    registerExactEvmScheme(client, { signer: this.#signer, networks: [network] });
    const http = new x402HTTPClient(client);
    return http.encodePaymentSignatureHeader(await http.createPaymentPayload(required));
  }
}

export interface PayingClientOptions {
  readonly signer?: X402Signer;
  readonly paymentHeaders?: PaymentHeaderFactory;
  readonly fetch?: Fetch;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

const boundedFetch = async (fetch_: Fetch, input: string | URL | Request, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal === null || init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout]);
  return fetch_(input, { ...init, signal });
};

export class PayingHttpClient {
  readonly #fetch: Fetch;
  readonly #paymentHeaders: PaymentHeaderFactory;
  readonly #maximum: number;
  readonly #timeoutMs: number;

  constructor(options: PayingClientOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (options.paymentHeaders !== undefined) this.#paymentHeaders = options.paymentHeaders;
    else if (options.signer !== undefined) this.#paymentHeaders = new LedgerX402PaymentHeaders(options.signer);
    else throw new Error("PayingHttpClient requires a signer or payment header factory");
    this.#maximum = z.number().int().positive().parse(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    this.#timeoutMs = z.number().int().positive().parse(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async requestPlain(url: URL, init: RequestInit = {}): Promise<Response> {
    return boundedFetch(this.#fetch, url, init, this.#timeoutMs);
  }

  async retryPayment(requiredResponse: Response, url: URL, init: RequestInit, network: `eip155:${string}`): Promise<Response> {
    if (requiredResponse.status !== 402) throw new Error("Payment retry requires an HTTP 402 response");
    const http = new x402HTTPClient(new x402Client());
    const requiredHeader = requiredResponse.headers.get("payment-required") ?? requiredResponse.headers.get("x-payment-required");
    const body = requiredHeader === null ? await readBoundedJson(requiredResponse.clone(), this.#maximum) : undefined;
    const required = http.getPaymentRequiredResponse((name) => requiredResponse.headers.get(name), body);
    const paymentHeaders = await this.#paymentHeaders.create(required, network);
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(paymentHeaders)) headers.set(name, value);
    return boundedFetch(this.#fetch, url, { ...init, headers }, this.#timeoutMs);
  }

  async request(url: URL, init: RequestInit, network: `eip155:${string}`): Promise<Response> {
    const first = await boundedFetch(this.#fetch, url, init, this.#timeoutMs);
    return first.status === 402 ? this.retryPayment(first, url, init, network) : first;
  }
}

export interface ParsedHttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

export const parseHttpJson = async (response: Response, maximum = DEFAULT_MAX_RESPONSE_BYTES): Promise<ParsedHttpResponse> => ({
  status: response.status,
  body: await readBoundedJson(response, maximum),
  headers: response.headers,
});
