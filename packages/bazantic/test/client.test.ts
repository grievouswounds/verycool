import { describe, expect, test } from "bun:test";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { Network, PaymentRequired } from "@x402/core/types";
import {
  BASE_NETWORK, BASE_USDC, BazanticCatalogClient, LedgerX402PaymentHeaders, PayingHttpClient, discoverGatewayTools,
  parseHttpJson, parseSseJson, readBoundedJson,
} from "../src/index.ts";

const details = {
  name: "Example", description: "Example gateway", tags: ["data"],
  url: "https://example.bazgateway.com", mcp: "https://example.bazgateway.com/mcp",
};
const sse = (value: unknown): Response => new Response(`event: message\ndata: ${JSON.stringify(value)}\n\n`, { headers: { "content-type": "text/event-stream" } });
const listEnvelope = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "example" }], structuredContent: { example: details } } };
const expectRejection = async (promise: Promise<unknown>, message: string): Promise<void> => {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain(message);
};

describe("Bazantic catalog recognizer", () => {
  test("normalizes strict catalog JSON delivered over SSE", async () => {
    const catalog = new BazanticCatalogClient({ fetch: () => Promise.resolve(sse(listEnvelope)) });
    const gateways = await catalog.listGateways();
    expect(gateways).toHaveLength(1);
    expect(gateways[0]?.endpointUrl).toBe(details.url);
    expect(gateways[0]?.slug).toBe("example");
  });

  test("rejects duplicate-key JSON and oversized bodies", async () => {
    expect(() => parseSseJson('event: message\ndata: {"id":1,"id":2}\n\n')).toThrow();
    await expectRejection(readBoundedJson(new Response('{"ok":true}'), 4), "byte limit");
  });

  test("discovers tools and treats 404 as no MCP", async () => {
    const catalog = new BazanticCatalogClient({ fetch: () => Promise.resolve(sse(listEnvelope)) });
    const gateway = (await catalog.listGateways())[0];
    if (gateway === undefined) throw new Error("missing fixture gateway");
    const tools = await discoverGatewayTools(gateway, { fetch: () => Promise.resolve(sse({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] } })) });
    expect(tools?.[0]?.name).toBe("lookup");
    expect(await discoverGatewayTools(gateway, { fetch: () => Promise.resolve(new Response("", { status: 404 })) })).toBeNull();
  });
});

const required = (network: Network, asset: string, amount: string, extra: Record<string, unknown> = {}): PaymentRequired => ({
  x402Version: 2,
  resource: { url: "https://resource.example/value" },
  accepts: [{ scheme: "exact", network, asset, amount, payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, extra }],
});

describe("paying HTTP client", () => {
  test("enforces Base USDC amount and network policy before signing", async () => {
    let signatures = 0;
    const headers = new LedgerX402PaymentHeaders({
      address: "0x2222222222222222222222222222222222222222",
      signTypedData: () => { signatures += 1; const signature: `0x${string}` = `0x${"00".repeat(65)}`; return Promise.resolve(signature); },
    });
    await expectRejection(headers.create(required(BASE_NETWORK, BASE_USDC, "10001"), { kind: "bazantic", maxAmount: "10000" }), "no allowed bazantic");
    await expectRejection(headers.create(required("eip155:31337", BASE_USDC, "1"), { kind: "bazantic", maxAmount: "10000" }), "No network/scheme registered");
    expect(signatures).toBe(0);
    const bazanticHeaders = await headers.create(required(BASE_NETWORK, BASE_USDC, "10000", { name: "USD Coin", version: "2" }), { kind: "bazantic", maxAmount: "10000" });
    expect(Object.keys(bazanticHeaders).map((name) => name.toLowerCase())).toContain("payment-signature");
    const aquaHeaders = await headers.create(required("eip155:31337", "0x3333333333333333333333333333333333333333", "42", {
      assetTransferMethod: "permit2", paymentFlow: "upfront",
      permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3", proxy: "0x402085c248eea27d92e8b30b2c58ed07f9e20001",
    }), { kind: "aqua", network: "eip155:31337" });
    expect(Object.keys(aquaHeaders).map((name) => name.toLowerCase())).toContain("payment-signature");
    expect(signatures).toBe(2);
  });

  test("does not pay 404 and retries a 402 once with the generated header", async () => {
    const seen: Headers[] = [];
    const fetch_ = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers); seen.push(headers);
      if (seen.length === 1) return Promise.resolve(new Response('{"error":"payment"}', { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(required(BASE_NETWORK, BASE_USDC, "10000")) } }));
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    };
    const client = new PayingHttpClient({ fetch: fetch_, paymentHeaders: { create: () => Promise.resolve({ "payment-signature": "signed" }) } });
    const catalog = new BazanticCatalogClient({ fetch: () => Promise.resolve(sse(listEnvelope)) });
    const gateway = (await catalog.listGateways())[0];
    if (gateway === undefined) throw new Error("missing fixture gateway");
    const response = await client.requestGateway(gateway, "v1/value", { method: "GET" }, "10000");
    expect((await parseHttpJson(response)).body).toEqual({ ok: true });
    expect(seen[0]?.has("payment-signature")).toBeFalse();
    expect(seen[1]?.get("payment-signature")).toBe("signed");

    const notFound = new PayingHttpClient({ fetch: () => Promise.resolve(new Response('{"error":"missing"}', { status: 404 })), paymentHeaders: { create: () => Promise.reject(new Error("must not pay")) } });
    expect((await notFound.requestGateway(gateway, "wrong", {}, "10000")).status).toBe(404);
  });

  test("settles an already received Aqua 402 without probing the endpoint again", async () => {
    let requests = 0;
    let policyKind: string | undefined;
    const client = new PayingHttpClient({
      fetch: (_input, init) => {
        requests += 1;
        expect(new Headers(init?.headers).get("payment-signature")).toBe("ledger-signed");
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      },
      paymentHeaders: {
        create: (_paymentRequired, policy) => {
          policyKind = policy.kind;
          return Promise.resolve({ "payment-signature": "ledger-signed" });
        },
      },
    });
    const challenge = required("eip155:31337", "0x3333333333333333333333333333333333333333", "42", {
      assetTransferMethod: "permit2", paymentFlow: "upfront",
    });
    const requiredResponse = new Response('{"error":"payment"}', {
      status: 402, headers: { "payment-required": encodePaymentRequiredHeader(challenge) },
    });
    const response = await client.retryAqua(requiredResponse, new URL("https://aqua.example/v1/trades"), { method: "POST" }, "eip155:31337");
    expect((await parseHttpJson(response)).body).toEqual({ ok: true });
    expect(requests).toBe(1);
    expect(policyKind).toBe("aqua");
  });

  test("refuses guessed gateways and absolute paths", async () => {
    const client = new PayingHttpClient({ fetch: () => Promise.resolve(new Response()), paymentHeaders: { create: () => Promise.resolve({}) } });
    const guessed = { slug: "guess", name: "Guess", description: "", endpointUrl: details.url, mcpUrl: null, tags: [] };
    await expectRejection(client.requestGateway(guessed, "v1", {}, "1"), "not issued");
    const catalog = new BazanticCatalogClient({ fetch: () => Promise.resolve(sse(listEnvelope)) });
    const gateway = (await catalog.listGateways())[0];
    if (gateway === undefined) throw new Error("missing fixture gateway");
    await expectRejection(client.requestGateway(gateway, "https://evil.example", {}, "1"), "relative");
  });
});
