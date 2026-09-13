import { describe, expect, test } from "bun:test";
import { nextFundedActivation, previewSubmitAllowed } from "../src/funded-activation.ts";

describe("previewSubmitAllowed", () => {
  const now = new Date("2026-09-13T18:00:00Z");
  const expired = new Date("2026-09-13T17:55:00Z");
  const fresh = new Date("2026-09-13T18:05:00Z");

  test("allows a live preview", () => {
    expect(previewSubmitAllowed({ expiresAt: fresh, now, paymentTransaction: null })).toBe(true);
  });

  test("rejects an expired preview with no payment", () => {
    expect(previewSubmitAllowed({ expiresAt: expired, now, paymentTransaction: null })).toBe(false);
  });

  test("allows funded activation after expires_at when payment_transaction exists", () => {
    expect(previewSubmitAllowed({
      expiresAt: expired,
      now,
      paymentTransaction: "0x4d8d8bcd6aaa3e58a289e19fbb8eade734f17ca7dc7c784768b0ca82ff0603a8",
    })).toBe(true);
  });
});

describe("nextFundedActivation", () => {
  test("returns 202 wait when vault code is still empty after deploy", () => {
    expect(nextFundedActivation({
      vaultCode: "0x",
      deploymentTransaction: "0x5139c887",
      deploymentReceipt: "missing",
    })).toEqual({
      action: "waitDeploy",
      activationError: "vault deployment submitted; call post_trade again with the same ids",
    });
  });

  test("deploys when vault code is empty and no deployment hash exists", () => {
    expect(nextFundedActivation({ vaultCode: "0x", deploymentTransaction: null, deploymentReceipt: null })).toEqual({ action: "deploy" });
  });

  test("executes after vault code exists", () => {
    expect(nextFundedActivation({
      vaultCode: "0x60806040",
      deploymentTransaction: "0x5139c887",
      deploymentReceipt: "success",
    })).toEqual({ action: "execute" });
  });

  test("redeploys when the previous factory transaction reverted", () => {
    expect(nextFundedActivation({
      vaultCode: "0x",
      deploymentTransaction: "0xdead",
      deploymentReceipt: "reverted",
    })).toEqual({ action: "deploy" });
  });
});
