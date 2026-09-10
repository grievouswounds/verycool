import { describe, expect, test } from "bun:test";
import { ANVIL_ACCOUNT_ZERO_KEY, GATEWAY_NAME, defaultDeployStack, parseDeployStack, parseTrycloudflareUrl } from "./deploy-bazantic-gateway.ts";
import { signingKeyAddress } from "@aqua/evm";

describe("Bazantic gateway deploy helpers", () => {
  test("extracts the trycloudflare origin from cloudflared logs", () => {
    const log = [
      "INF Requesting new quick Tunnel on trycloudflare.com...",
      "INF |  https://merchant-updating-genome-rate.trycloudflare.com                                   |",
    ].join("\n");
    expect(parseTrycloudflareUrl(log)).toBe("https://merchant-updating-genome-rate.trycloudflare.com");
    expect(parseTrycloudflareUrl("no url here")).toBeUndefined();
  });

  test("pins the Anvil account-zero key to the well-known address", () => {
    expect(GATEWAY_NAME).toBe("Aqua transaction preparation API");
    expect(signingKeyAddress(ANVIL_ACCOUNT_ZERO_KEY).toLowerCase()).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });

  test("selects the physical stack only when the Ledger keyring is complete", () => {
    expect(defaultDeployStack({ keyringPresent: true })).toBe("dev");
    expect(defaultDeployStack({ keyringPresent: false })).toBe("dev-emulated");
    expect(parseDeployStack("dev-emulated")).toBe("dev-emulated");
  });
});
