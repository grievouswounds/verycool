import { describe, expect, test } from "bun:test";
import { AppError } from "@aqua/core";
import {
  authorizePageHtml,
  escapeHtml,
  renderAppErrorFragment,
  renderBrowserError,
  renderEnrollmentPanel,
} from "../src/authorize.ts";

describe("authorize page renderers", () => {
  test("escapes a hostile owner address", () => {
    const hostile = `0x"><img src=x onerror="alert(1)">`;
    const html = renderEnrollmentPanel(hostile);
    expect(html).toContain(escapeHtml(hostile));
    expect(html).not.toContain(hostile);
  });

  test("shell page loads htmx from self", () => {
    expect(authorizePageHtml).toContain("/authorize/htmx.js");
    expect(authorizePageHtml).toContain(`content='{"allowEval":false,"selfRequestsOnly":true}'`);
  });

  test("404 credential error produces the enrollment panel", () => {
    const address = "0x1111111111111111111111111111111111111111";
    const html = renderAppErrorFragment(new AppError(404, "urn:aqua:error:webauthn-credential", "missing"), address);
    expect(html).toContain("Not on the guest list");
    expect(html).toContain("bun scripts/setup-hosted-owner.ts");
    expect(html).toContain(address);
  });

  test("idle copy sends MCP Jam back with iss rather than a CLI loopback", () => {
    expect(authorizePageHtml).toContain("MCP Jam");
    expect(authorizePageHtml).not.toContain("loopback listener the CLI is holding open");
  });

  test("maps AppError types to themed fragments", () => {
    expect(renderAppErrorFragment(new AppError(409, "urn:aqua:error:webauthn-challenge", "stale"))).toContain("Your password expired");
    expect(renderAppErrorFragment(new AppError(401, "urn:aqua:error:webauthn-assertion", "bad"))).toContain("does not know that handshake");
    expect(renderAppErrorFragment(new AppError(401, "urn:aqua:error:ledger-attestation", "fake"))).toContain("does not know that handshake");
    expect(renderAppErrorFragment(new AppError(400, "invalid_request", "client"))).toContain("not on the list");
    expect(renderAppErrorFragment(new AppError(401, "urn:aqua:error:webauthn-credential", "bound"))).toContain("not on this register");
  });

  test("browser errors have distinct copy", () => {
    expect(renderBrowserError("NotAllowedError")).toContain("peephole closed");
    expect(renderBrowserError("SecurityError")).toContain("127.0.0.1");
    expect(renderBrowserError("NotFoundError")).toContain("No device at the door");
  });
});
