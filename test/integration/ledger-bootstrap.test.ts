import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

const fixture = async (): Promise<{ readonly root: string; readonly state: string; readonly bin: string }> => {
  const root = await mkdtemp(`${tmpdir()}/aqua-ledger-bootstrap.`);
  temporaryDirectories.push(root);
  const state = `${root}/state`;
  const bin = `${root}/bin`;
  await mkdir(bin, { recursive: true });
  const executable = async (name: string, body: string): Promise<void> => {
    const path = `${bin}/${name}`;
    await Bun.write(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    await chmod(path, 0o700);
  };
  await executable("uname", '[[ "${1:-}" == "-s" ]] && echo Darwin || echo arm64');
  await executable("pgrep", "exit 1");
  await executable("security", '[[ "$1" == "find-generic-password" ]] && exit 1; exit 0');
  await executable("openssl", 'printf "%064d\\n" 0');
  await executable("bun", 'printf "k4.secret.%086d" 0');
  await executable("wallet-cli", `
if [[ "$1 $2" == "ring encrypt" ]]; then
  output=""; key=""
  while [[ $# -gt 0 ]]; do
    [[ "$1" == "-o" ]] && output="$2"
    [[ "$1" == "--key" ]] && key="$2"
    shift
  done
  IFS= read -r secret || true
  [[ "\${MOCK_FAIL_KEY:-}" == "$key" ]] && exit 9
  printf '%s' "$secret" > "${root}/captured-$key"
  printf 'encrypted' > "$output"
else
  printf '{}\\n'
fi`);
  return { root, state, bin };
};

const invoke = async (item: Awaited<ReturnType<typeof fixture>>, input = "password\npassword\n", environment: Record<string, string> = {}) => {
  const child = Bun.spawn(["bash", "scripts/ledger-bootstrap.sh", "--prod"], {
    cwd: globalThis.process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: {
      ...Bun.env,
      AQUA_E2E: "0",
      AQUA_LEDGER: "physical",
      AQUA_LEDGER_TRANSPORT: "node-hid",
      AQUA_WALLET_CLI: `${item.bin}/wallet-cli`,
      ...environment,
      PATH: `${item.bin}:${Bun.env["PATH"] ?? ""}`,
      AQUA_STATE_DIR: item.state,
    },
  });
  await child.stdin.write(input);
  await child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

describe("atomic Ledger keyring bootstrap", () => {
  test("rejects a partial keyring without overwriting it", async () => {
    const item = await fixture();
    await mkdir(`${item.state}/keyring`, { recursive: true });
    await Bun.write(`${item.state}/keyring/agent.enc`, "keep-me");
    const result = await invoke(item);
    expect(result.exitCode).not.toBe(0);
    expect(await Bun.file(`${item.state}/keyring/agent.enc`).text()).toBe("keep-me");
  });

  test("rejects mismatched passwords before creating a keyring", async () => {
    const item = await fixture();
    const result = await invoke(item, "one\ntwo\n");
    expect(result.exitCode).not.toBe(0);
    expect(await Bun.file(`${item.state}/keyring`).exists()).toBe(false);
  });

  test("generates three EVM keys and one Ed25519 PASETO secret, then reuses them", async () => {
    const item = await fixture();
    const result = await invoke(item);
    if (result.exitCode !== 0) throw new Error(result.stderr.length > 0 ? result.stderr : result.stdout);
    expect(result.exitCode).toBe(0);
    for (const name of ["agent", "facilitator", "keeper", "paseto"]) {
      expect(await Bun.file(`${item.state}/keyring/${name}.enc`).exists()).toBe(true);
    }
    expect(await Bun.file(`${item.root}/captured-agent`).text()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await Bun.file(`${item.root}/captured-paseto`).text()).toMatch(/^k4\.secret\.[A-Za-z0-9_-]{86}$/);
    const second = await invoke(item, "");
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already exists");
  });

  test("leaves no installed keyring when encryption fails", async () => {
    const item = await fixture();
    const result = await invoke(item, "password\npassword\n", { MOCK_FAIL_KEY: "keeper" });
    expect(result.exitCode).not.toBe(0);
    expect(await Bun.file(`${item.state}/keyring`).exists()).toBe(false);
  });
});
