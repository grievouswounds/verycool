import { describe, expect, test } from "bun:test";

const python = Bun.env["AQUA_PYTHON"] ?? "python3";

const run = (source: string): string => {
  const result = Bun.spawnSync([python, "-c", source], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${result.stderr.toString()}${result.stdout.toString()}`);
  }
  return result.stdout.toString().trim();
};

describe("physical CTAP HID selection", () => {
  test("skips U2F-only devices and keeps the first CTAP2 HID", () => {
    expect(run(`
from ctap_hid import pick_ctap2_device
class Device:
    def __init__(self, capabilities):
        self.capabilities = capabilities
chosen, skipped = pick_ctap2_device([Device(0x01), Device(0x04), Device(0x05)])
print(chosen.capabilities, [item.capabilities for item in skipped])
`)).toBe("4 [1, 5]");
  });

  test("waits until a CTAP2 device appears", () => {
    expect(run(`
from ctap_hid import wait_for_ctap2_device
class Device:
    def __init__(self, capabilities):
        self.capabilities = capabilities
        self.closed = False
    def close(self):
        self.closed = True
calls = {"n": 0}
def list_devices():
    calls["n"] += 1
    if calls["n"] == 1:
        return [Device(0x01)]
    return [Device(0x04)]
clock = iter([0, 0, 1]).__next__
chosen = wait_for_ctap2_device(list_devices, timeout_s=10, sleep=lambda _s: None, clock=clock, warn=lambda _m: None)
print(chosen.capabilities, calls["n"])
`)).toBe("4 2");
  });

  test("keeps polling when HID INIT fails mid-enumeration", () => {
    expect(run(`
from ctap_hid import wait_for_ctap2_device
class Device:
    def __init__(self, capabilities):
        self.capabilities = capabilities
    def close(self):
        pass
calls = {"n": 0}
def list_devices():
    calls["n"] += 1
    if calls["n"] == 1:
        def gen():
            yield Device(0x01)
            raise OSError("Failed reading a response")
        return gen()
    return [Device(0x04)]
clock = iter([0, 0, 1]).__next__
chosen = wait_for_ctap2_device(list_devices, timeout_s=10, sleep=lambda _s: None, clock=clock, warn=lambda _m: None)
print(chosen.capabilities, calls["n"])
`)).toBe("4 2");
  });
});
