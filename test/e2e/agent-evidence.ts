import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { addressSchema, hexSchema } from "@aqua/core";
import { recoverTypedDataAddress } from "@aqua/evm";
import type { Eip712TypedData } from "@aqua/evm";
import { z } from "zod";

const signer = Bun.env["AQUA_AGENT_SIGNER"];
const output = Bun.env["AQUA_E2E_REPORT"];
if (signer === undefined || output === undefined) throw new Error("Agent evidence environment is incomplete");

const run = async (mode: string, input?: unknown): Promise<unknown> => {
  const child = Bun.spawn([process.execPath, signer, mode], {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: Bun.env,
  });
  if (input !== undefined) {
    const stdin = child.stdin;
    if (stdin === undefined || typeof stdin === "number") throw new Error("Agent signer stdin is unavailable");
    await stdin.write(JSON.stringify(input));
    await stdin.end();
  }
  const text = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(`Agent signer ${mode} failed`);
  return JSON.parse(text) as unknown;
};

const provisioned = z.object({ address: addressSchema, ciphertextPath: z.string() }).loose().parse(await run("provision"));
const typedData: Eip712TypedData = {
  domain: { name: "Aqua E2E", version: "1", chainId: 31_337 },
  types: { Evidence: [{ name: "purpose", type: "string" }] },
  primaryType: "Evidence",
  message: { purpose: "prove-lkrp-agent-signing-boundary" },
};
const signed = z.object({ address: addressSchema, signature: hexSchema }).strict()
  .parse(await run("sign-typed-data", { typedData }));
const recovered = recoverTypedDataAddress(typedData, signed.signature);
if (signed.address.toLowerCase() !== provisioned.address.toLowerCase()
  || recovered.toLowerCase() !== provisioned.address.toLowerCase()) {
  throw new Error("LKRP agent signature did not recover to the provisioned address");
}

await mkdir(dirname(output), { recursive: true });
await Bun.write(output, `${JSON.stringify({
  address: provisioned.address,
  recoveredSigner: recovered,
  ciphertextPersisted: true,
  signatureVerified: true,
}, null, 2)}\n`);
