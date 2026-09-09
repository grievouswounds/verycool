#!/usr/bin/env bun
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

if (Bun.env["AQUA_E2E"] !== "1") throw new Error("The E2E wallet-cli adapter cannot run outside AQUA_E2E=1");
const state = Bun.env["AQUA_E2E_LKRP_STATE"];
const password = Bun.env["WALLET_PASS"];
if (state === undefined || password === undefined || password.length === 0) throw new Error("AQUA_E2E_LKRP_STATE and WALLET_PASS are required");
const args = Bun.argv.slice(2);
const command = args.slice(0, 2).join(" ");
const marker = `${state}/initialized`;
const value = (flag: string): string | null => { const index = args.indexOf(flag); return index === -1 ? null : (args[index + 1] ?? null); };
const key = createHash("sha256").update(`aqua-e2e-lkrp:${password}`).digest();

const appProof = async (): Promise<void> => {
  const base = Bun.env["AQUA_SPECULOS_URL"] ?? "http://127.0.0.1:5000";
  const response = await fetch(new URL("/apdu", base), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: "e003000000" }),
  });
  if (!response.ok) throw new Error(`Ledger Sync Speculos APDU failed with HTTP ${String(response.status)}`);
  const body = await response.json() as { readonly data?: string };
  if (typeof body.data !== "string" || !body.data.toLowerCase().endsWith("9000")) throw new Error("Ledger Sync app did not answer the application-info APDU");
};

if (command === "ring init") {
  if (!await Bun.file(marker).exists()) await appProof();
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ command, rootId: "speculos-e2e-root", memberName: "aqua-e2e" })}\n`);
} else if (command === "ring keys") {
  if (!await Bun.file(marker).exists()) process.exit(1);
  process.stdout.write(`${JSON.stringify({ command, keys: [] })}\n`);
} else if (command === "ring encrypt") {
  if (!await Bun.file(marker).exists()) process.exit(1);
  const output = value("-o") ?? value("--out"); const domain = value("--key");
  if (output === null || domain === null) throw new Error("ring encrypt requires --key and -o/--out");
  const plaintext = Buffer.from(await Bun.stdin.arrayBuffer()); const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(Buffer.from(domain));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); const tag = cipher.getAuthTag();
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, Buffer.concat([Buffer.from("ALKR1"), nonce, tag, ciphertext]), { mode: 0o600 });
  await chmod(output, 0o600);
  process.stdout.write(`${JSON.stringify({ command, output, bytes: ciphertext.length })}\n`);
} else if (command === "ring decrypt") {
  if (!await Bun.file(marker).exists()) process.exit(1);
  const input = value("-i") ?? value("--input"); const domain = value("--key");
  if (input === null || domain === null) throw new Error("ring decrypt requires --key and -i/--input");
  const payload = Buffer.from(await readFile(input));
  if (payload.subarray(0, 5).toString() !== "ALKR1" || payload.length < 33) throw new Error("Ledger Key Ring ciphertext is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(5, 17));
  decipher.setAAD(Buffer.from(domain)); decipher.setAuthTag(payload.subarray(17, 33));
  process.stdout.write(Buffer.concat([decipher.update(payload.subarray(33)), decipher.final()]));
} else {
  throw new Error(`Unsupported E2E wallet-cli command: ${command}`);
}
