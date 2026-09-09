import { describe, expect, test } from "bun:test";
import { PayingHttpClient, parseHttpJson } from "@aqua/bazantic";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { retryAquaPayment } from "../src/payment.ts";

describe("MCP bridge Aqua payment handoff", () => {
  test("passes the received Permit2 challenge to the Ledger-backed payer for one retry", async () => {
    let requests = 0;
    let selectedPolicy: string | undefined;
    const client = new PayingHttpClient({
      fetch: (_input, init) => {
        requests += 1;
        expect(new Headers(init?.headers).get("payment-signature")).toBe("ledger-signature");
        return Promise.resolve(new Response('{"state":"submitted"}', { status: 202 }));
      },
      paymentHeaders: {
        create: (_required, policy) => {
          selectedPolicy = policy.kind;
          return Promise.resolve({ "payment-signature": "ledger-signature" });
        },
      },
    });
    const challenge: PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://aqua.example/v1/trades" },
      accepts: [{
        scheme: "exact", network: "eip155:31337",
        asset: "0x3333333333333333333333333333333333333333", amount: "42",
        payTo: "0x4444444444444444444444444444444444444444", maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: "permit2", paymentFlow: "upfront" },
      }],
    };
    const requiredResponse = new Response('{"state":"payment-required"}', {
      status: 402, headers: { "payment-required": encodePaymentRequiredHeader(challenge) },
    });

    const response = await retryAquaPayment(
      client, requiredResponse, new URL("https://aqua.example/v1/trades"), { method: "POST" }, "eip155:31337",
    );

    expect((await parseHttpJson(response)).body).toEqual({ state: "submitted" });
    expect(response.status).toBe(202);
    expect(requests).toBe(1);
    expect(selectedPolicy).toBe("aqua");
  });
});
