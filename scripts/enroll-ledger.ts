#!/usr/bin/env bun
import { addressSchema } from "@aqua/core";
import { z } from "zod";
import { ledgerOwnerAddress, signLedgerMessage } from "../apps/mcp-bridge/src/ledger.ts";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const apiUrl = Bun.env["AQUA_API_URL"] ?? "http://127.0.0.1:3000";
const python = Bun.env["AQUA_PYTHON"] ?? fail("AQUA_PYTHON is unset. Enter the Nix shell with `nix develop` so python-fido2 is on PATH.");
const helper = `${import.meta.dir}/../test/e2e/webauthn-ctap.py`;

const probe = Bun.spawn([python, "-c", "import fido2"], { stdout: "ignore", stderr: "pipe" });
if (await probe.exited !== 0) {
  fail("python-fido2 is unavailable. Enter the Nix shell with `nix develop` and retry.");
}

const json = async (response: Response): Promise<unknown> => {
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`enroll-ledger ${String(response.status)} ${response.url}: ${JSON.stringify(body)}`);
  return body;
};

const ctap = async (request: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> => {
  console.error(request["mode"] === "create"
    ? "Open the Security Key app and approve Ledger FIDO2 registration."
    : "Approve the Ledger FIDO2 assertion on the Security Key app.");
  const child = Bun.spawn([python, helper], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: Bun.env });
  await child.stdin.write(JSON.stringify(request));
  await child.stdin.end();
  const text = await new Response(child.stdout).text();
  if (await child.exited !== 0) {
    fail(`webauthn-ctap.py failed: ${text}\nIf python-fido2 is missing, enter the Nix shell with \`nix develop\`.`);
  }
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
};

const origin = new URL(apiUrl).origin;
console.error("Open the Ethereum app and sign the SIWE enrollment challenge.");
const owner = await ledgerOwnerAddress();
const challenge = z.object({ challengeId: z.uuid(), message: z.string() }).loose()
  .parse(await json(await fetch(new URL("/v1/auth/challenges", apiUrl), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: owner }),
  })));
const signature = await signLedgerMessage(owner, challenge.message);
const session = z.object({ accessToken: z.string().min(1) }).loose()
  .parse(await json(await fetch(new URL("/v1/auth/sessions", apiUrl), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, message: challenge.message, signature }),
  })));
const registration = z.object({
  id: z.uuid(),
  options: z.object({
    challenge: z.string(), rp: z.object({ id: z.string(), name: z.string() }).loose(),
    user: z.object({ id: z.string(), name: z.string() }).loose(),
  }).loose(),
}).loose().parse(await json(await fetch(new URL("/v1/auth/ledger/registration/options", apiUrl), {
  method: "POST", headers: { authorization: `Bearer ${session.accessToken}` },
})));
const attestation = await ctap({
  mode: "create", origin, rpId: registration.options.rp.id, rpName: registration.options.rp.name,
  challenge: registration.options.challenge, userId: registration.options.user.id, userName: registration.options.user.name,
});
const enrolled = z.object({ owner: addressSchema, credentialId: z.string() }).loose()
  .parse(await json(await fetch(new URL("/v1/auth/ledger/registration/verify", apiUrl), {
    method: "POST", headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ id: registration.id, response: attestation }),
  })));
console.log(`Enrolled ${enrolled.owner} credential ${enrolled.credentialId}`);
