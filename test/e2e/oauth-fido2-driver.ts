#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { addressSchema } from "@aqua/core";
import { z } from "zod";
import { ledgerOwnerAddress, signLedgerMessage } from "../../apps/mcp-bridge/src/ledger.ts";

const authorizeUrl = process.argv[2];
const apiUrl = Bun.env["AQUA_API_URL"];
const python = Bun.env["AQUA_PYTHON"];
const helper = `${import.meta.dir}/webauthn-ctap.py`;
if (authorizeUrl === undefined || apiUrl === undefined || python === undefined) {
  throw new Error("OAuth FIDO2 driver environment is incomplete");
}

const json = async (response: Response): Promise<unknown> => {
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`OAuth driver ${String(response.status)} ${response.url}: ${JSON.stringify(body)}`);
  return body;
};
const ctap = async (request: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> => {
  if (Bun.env["AQUA_E2E_PHYSICAL"] === "1") {
    console.error(request["mode"] === "create"
      ? "Open the Security Key app and approve Ledger FIDO2 registration."
      : "Approve the Ledger FIDO2 assertion on the Security Key app.");
  }
  const child = Bun.spawn([python, helper], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: Bun.env });
  await child.stdin.write(JSON.stringify(request));
  await child.stdin.end();
  const text = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(`webauthn-ctap.py failed: ${text}`);
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
};

const origin = new URL(apiUrl).origin;
const ownerEvidence = Bun.env["AQUA_LEDGER_OWNER_EVIDENCE"];
const owner = ownerEvidence === undefined
  ? await ledgerOwnerAddress()
  : z.object({ owner: addressSchema }).loose().parse(JSON.parse(await readFile(ownerEvidence, "utf8"))).owner;
if (Bun.env["AQUA_E2E_PHYSICAL"] === "1") console.error("Open the Ethereum app and sign the SIWE enrollment challenge.");
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
await json(await fetch(new URL("/v1/auth/ledger/registration/verify", apiUrl), {
  method: "POST", headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" },
  body: JSON.stringify({ id: registration.id, response: attestation }),
}));

const authorize = new URL(authorizeUrl);
const authorization = Object.fromEntries(
  ["client_id", "redirect_uri", "resource", "scope", "state", "code_challenge", "code_challenge_method", "response_type"]
    .map((name) => [name, authorize.searchParams.get(name)]),
);
if (Object.values(authorization).some((value) => value === null)) throw new Error("Authorize URL is missing OAuth parameters");
const started = z.object({
  id: z.uuid(),
  options: z.object({
    challenge: z.string(), rpId: z.string().optional(),
    allowCredentials: z.array(z.object({ id: z.string() }).loose()).optional(),
  }).loose(),
}).loose().parse(await json(await fetch(new URL("/oauth/authorize/start", apiUrl), {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: owner, authorization }),
})));
const assertion = await ctap({
  mode: "get", origin, rpId: started.options.rpId ?? new URL(apiUrl).hostname, challenge: started.options.challenge,
  allowCredentials: started.options.allowCredentials ?? [],
});
const completed = z.object({ redirect_uri: z.url() }).loose()
  .parse(await json(await fetch(new URL("/oauth/authorize/complete", apiUrl), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: started.id, response: assertion }),
  })));
const redirected = await fetch(completed.redirect_uri, { redirect: "manual" }).catch((error: unknown) => {
  if (error instanceof Error && /ECONNRESET|connection was closed/iu.test(error.message)) return undefined;
  throw error;
});
if (redirected !== undefined && redirected.status >= 400) throw new Error(`OAuth callback failed: ${String(redirected.status)}`);
if (Bun.env["AQUA_E2E_PHYSICAL"] === "1") console.error("Switch back to the Ethereum app for trade delegation signing.");
