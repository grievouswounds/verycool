#!/usr/bin/env bun
import "./json-bigint.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { addressSchema, hexSchema } from "@aqua/core";
import type { Hex } from "@aqua/core";
import { CubaneTransactionSigner, randomSigningKey, signTypedData, signingKeyAddress } from "@aqua/evm";
import type { Eip712TypedData } from "@aqua/evm";
import { z } from "zod";

const mode = Bun.argv[2];
const ciphertextPath = Bun.env["AQUA_AGENT_CIPHERTEXT"];
const metadataPath = Bun.env["AQUA_AGENT_METADATA"];
if (ciphertextPath === undefined || metadataPath === undefined) throw new Error("AQUA_AGENT_CIPHERTEXT and AQUA_AGENT_METADATA are required");
const walletCli = Bun.env["AQUA_WALLET_CLI"] ?? "wallet-cli";

const run = async (arguments_: readonly string[], input: string | null, inherit = false): Promise<string> => {
  const child = Bun.spawn([walletCli, ...arguments_], { stdin: input === null ? (inherit ? "inherit" : "ignore") : "pipe", stdout: "pipe", stderr: inherit ? "inherit" : "pipe" });
  if (input !== null) { const writer = child.stdin; if (writer === undefined || typeof writer === "number") throw new Error("wallet-cli stdin is unavailable"); await writer.write(input); await writer.end(); }
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), inherit ? Promise.resolve("") : new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`wallet-cli ${arguments_.join(" ")} failed: ${stderr.trim().slice(0, 240)}`);
  return stdout.trim();
};

if (mode === "provision") {
  try { await run(["ring", "keys", "--output", "json"], null); }
  catch {
    if (Bun.env["WALLET_PASS"] === undefined || Bun.env["WALLET_PASS"].length === 0) throw new Error("WALLET_PASS must be supplied by the user before Ledger Key Ring initialization");
    await run(["ring", "init"], null, true);
  }
  await mkdir(dirname(ciphertextPath), { recursive: true, mode: 0o700 });
  const e2ePrivateKey = Bun.env["AQUA_E2E_AGENT_PRIVATE_KEY"];
  if (e2ePrivateKey !== undefined && Bun.env["AQUA_E2E"] !== "1") {
    throw new Error("AQUA_E2E_AGENT_PRIVATE_KEY is restricted to AQUA_E2E=1");
  }
  const privateKey = e2ePrivateKey === undefined ? randomSigningKey() : hexSchema.parse(e2ePrivateKey);
  if (privateKey.length !== 66) throw new Error("Agent private key must contain exactly 32 bytes");
  const address = signingKeyAddress(privateKey);
  await run(["ring", "encrypt", "--key", "aqua-agent", "-o", ciphertextPath], privateKey);
  const metadata = { address, ciphertextPath, createdAt: new Date().toISOString() };
  await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
} else if (mode === "sign-typed-data") {
  const privateKeySchema = z.custom<Hex>((value) => hexSchema.safeParse(value).success && typeof value === "string" && value.length === 66);
  const typedDataSchema = z.custom<Eip712TypedData>((value) => typeof value === "object" && value !== null && "domain" in value && "types" in value && "primaryType" in value && "message" in value);
  const request = z.object({ typedData: typedDataSchema }).strict().parse(await Bun.stdin.json());
  const privateKey = privateKeySchema.parse(await run(["ring", "decrypt", "-i", ciphertextPath, "--key", "aqua-agent"], null));
  const address = addressSchema.parse(signingKeyAddress(privateKey)); const signature = signTypedData(privateKey, request.typedData);
  process.stdout.write(`${JSON.stringify({ address, signature })}\n`);
} else if (mode === "sign-transaction") {
  const decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
  const request = z.object({ transaction: z.object({
    chainId: z.number().int().positive(), nonce: decimal, maxPriorityFeePerGas: decimal,
    maxFeePerGas: decimal, gas: decimal, to: addressSchema, value: decimal, data: hexSchema,
  }).strict() }).strict().parse(await Bun.stdin.json());
  const privateKey = hexSchema.parse(await run(["ring", "decrypt", "-i", ciphertextPath, "--key", "aqua-agent"], null));
  if (privateKey.length !== 66) throw new Error("Ledger Key Ring agent key is invalid");
  const signer = new CubaneTransactionSigner(privateKey);
  const transaction = request.transaction;
  const rawTransaction = signer.sign({
    chainId: BigInt(transaction.chainId), nonce: BigInt(transaction.nonce),
    maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas), maxFeePerGas: BigInt(transaction.maxFeePerGas),
    gas: BigInt(transaction.gas), to: transaction.to, value: BigInt(transaction.value), data: transaction.data,
  });
  process.stdout.write(`${JSON.stringify({ address: signer.address, rawTransaction })}\n`);
} else {
  throw new Error("Usage: aqua-mcp-signer provision|sign-typed-data|sign-transaction");
}
