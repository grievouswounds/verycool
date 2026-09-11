#!/usr/bin/env bun
import { addressSchema, hashSchema, hexSchema, localProfileDefaults, parseRuntimeManifest } from "@aqua/core";
import type { Address, Hex } from "@aqua/core";
import { CubaneTransactionSigner, createPooledRpcClient, encodeMint, quantityToHex } from "@aqua/evm";
import { z } from "zod";
import { applyLedgerArgv } from "./ledger-mode.ts";
import { signLedgerTypedData } from "../apps/mcp-bridge/src/ledger.ts";
import { ctapHelper, enrollLedgerOwner } from "./enroll-ledger.ts";

applyLedgerArgv(Bun.argv.slice(2));

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const apiUrl = Bun.env["AQUA_API_URL"] ?? fail("AQUA_API_URL is required (use the pinned origin https://vercel-henna-gamma-46.vercel.app)");
const fund = Bun.argv.includes("--fund");

const json = async (response: Response, label: string): Promise<unknown> => {
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`${label} ${String(response.status)} ${response.url}: ${JSON.stringify(body)}`);
  return body;
};

const waitReceipt = async (rpc: ReturnType<typeof createPooledRpcClient>, hash: string): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const receipt = await rpc.transactionReceipt(hashSchema.parse(hash));
    if (receipt?.status === "success") return;
    if (receipt?.status === "reverted") fail(`Funding transaction reverted: ${hash}`);
    await Bun.sleep(400);
  }
  fail(`Funding transaction timed out: ${hash}`);
};

const enrolled = await enrollLedgerOwner(apiUrl);
console.error(`Enrolled ${enrolled.owner}. Keep the Security Key app open and authenticate for a hardware PASETO.`);
const origin = new URL(apiUrl).origin;
const authentication = z.object({
  id: z.uuid(),
  options: z.object({
    challenge: z.string(),
    rpId: z.string().optional(),
    allowCredentials: z.array(z.object({ id: z.string() }).loose()).optional(),
  }).loose(),
}).loose().parse(await json(await fetch(new URL("/v1/auth/ledger/authentication/options", apiUrl), {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: enrolled.owner }),
}), "authenticate options"));
const assertion = await ctapHelper({
  mode: "get", origin, rpId: authentication.options.rpId ?? new URL(apiUrl).hostname,
  challenge: authentication.options.challenge,
  allowCredentials: authentication.options.allowCredentials ?? [],
});
const hardware = z.object({ accessToken: z.string().min(1) }).loose()
  .parse(await json(await fetch(new URL("/v1/auth/ledger/authentication/verify", apiUrl), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: authentication.id, response: assertion, clientId: "aqua-setup-hosted-owner" }),
  }), "authenticate verify"));
const provisioned = z.object({ owner: addressSchema, agent: addressSchema }).loose()
  .parse(await json(await fetch(new URL("/v1/agents/provision", apiUrl), {
    method: "POST", headers: { authorization: `Bearer ${hardware.accessToken}` },
  }), "provision"));
console.error(`Provisioned hosted agent ${provisioned.agent}. Open the Ethereum app for fixture-token delegations.`);
const manifest = parseRuntimeManifest(Bun.env["AQUA_RUNTIME_MANIFEST"] ?? fail("AQUA_RUNTIME_MANIFEST is required so fixture tokens can be delegated"));
const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
for (const token of manifest.fixtures.tokens) {
  const preview = z.object({ previewId: z.uuid(), previewHash: hexSchema, typedData: z.record(z.string(), z.unknown()) }).loose()
    .parse(await json(await fetch(new URL("/v1/delegations/previews", apiUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${hardware.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: provisioned.agent, token: token.address, maxPerOrder: "1", maxPerDay: "100", expiresAt }),
    }), "delegation preview"));
  const ownerSignature = await signLedgerTypedData(enrolled.owner, preview.typedData);
  const submitted = z.object({ transactionHash: hexSchema }).loose()
    .parse(await json(await fetch(new URL("/v1/delegations", apiUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${hardware.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ previewId: preview.previewId, previewHash: preview.previewHash, ownerSignature }),
    }), "delegation submit"));
  console.error(`Delegated ${token.symbol} ${token.address} tx ${submitted.transactionHash}`);
}
if (fund) {
  const deployer = hexSchema.parse(Bun.env["AQUA_DEPLOYER_PRIVATE_KEY"] ?? fail("--fund requires AQUA_DEPLOYER_PRIVATE_KEY"));
  const rpc = createPooledRpcClient({ id: manifest.chain.id, rpcUrl: manifest.chain.rpcUrl }, localProfileDefaults.rpcTimeoutMs);
  const signer = new CubaneTransactionSigner(deployer);
  const session = rpc.session();
  const send = async (to: Address, data: Hex, value: bigint): Promise<void> => {
    const [nonce, gasPrice, priority] = await Promise.all([session.transactionCount(signer.address), session.gasPrice(), session.maxPriorityFeePerGas()]);
    const gas = await session.estimateGas({ from: signer.address, to, data, value: quantityToHex(value) });
    const raw = signer.sign({ chainId: BigInt(manifest.chain.id), nonce, maxPriorityFeePerGas: priority, maxFeePerGas: gasPrice * 2n + priority, gas, to, value, data });
    await waitReceipt(rpc, await session.sendRawTransaction(raw));
  };
  await send(provisioned.agent, hexSchema.parse("0x"), 10n ** 16n);
  for (const token of manifest.fixtures.tokens) {
    await send(token.address, encodeMint(provisioned.agent, 10n ** BigInt(token.decimals)), 0n);
  }
  console.error(`Funded ${provisioned.agent} with native gas and fixture tokens.`);
}
console.log(JSON.stringify({
  owner: enrolled.owner,
  agent: provisioned.agent,
  origin,
  setup: `${origin}/setup?owner=${enrolled.owner}`,
  next: [
    "Fund the agent with native gas and the sell token if you did not pass --fund.",
    `Add ${origin}/mcp in MCP Jam (OAuth, no extra headers). Unique *.vercel.app URLs fail WebAuthn.`,
  ],
}, null, 2));
