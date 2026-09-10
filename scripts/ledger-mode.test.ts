import { describe, expect, test } from "bun:test";
import { applyLedgerMode, parseLedgerArgv, parseLedgerValue } from "./ledger-mode.ts";

describe("ledger mode flags", () => {
  test("parses --dev, --prod, and --ledger", () => {
    expect(parseLedgerArgv(["bun", "x.ts", "--dev", "gateway"], {}).mode).toBe("emulator");
    expect(parseLedgerArgv(["bun", "x.ts", "--prod"], {}).mode).toBe("physical");
    expect(parseLedgerArgv(["bun", "x.ts", "--ledger", "emulator"], {}).mode).toBe("emulator");
    expect(parseLedgerArgv(["bun", "x.ts", "--ledger=physical"], {}).mode).toBe("physical");
    expect(parseLedgerArgv(["bun", "x.ts", "gateway", "--dev"], {}).rest).toEqual(["bun", "x.ts", "gateway"]);
    expect(parseLedgerArgv(["bun", "x.ts", "gateway", "--dev"], {}).explicit).toBe(true);
    expect(parseLedgerArgv(["bun", "x.ts", "gateway"], {}).explicit).toBe(false);
  });

  test("rejects combining --dev and --prod", () => {
    expect(() => parseLedgerArgv(["--dev", "--prod"], {})).toThrow(/cannot be combined/);
  });

  test("accepts emulated as an alias of emulator", () => {
    expect(parseLedgerValue("emulated")).toBe("emulator");
  });

  test("applies Speculos env for emulator and HID for physical", () => {
    const emulator: NodeJS.ProcessEnv = { AQUA_ROOT: "/repo" };
    applyLedgerMode("emulator", emulator);
    expect(emulator["AQUA_LEDGER"]).toBe("emulator");
    expect(emulator["AQUA_E2E"]).toBe("1");
    expect(emulator["AQUA_LEDGER_TRANSPORT"]).toBe("speculos");
    expect(emulator["AQUA_WALLET_CLI"]).toBe("/repo/test/e2e/wallet-cli-adapter.ts");
    const physical: NodeJS.ProcessEnv = {};
    applyLedgerMode("physical", physical);
    expect(physical["AQUA_LEDGER_TRANSPORT"]).toBe("node-hid");
  });
});
