#!/usr/bin/env bun
import { hexSchema } from "@aqua/core";
import { bytesToHex, hexToBytes, initializeCubane, signingKeyAddress } from "@aqua/evm";
import { secp256k1 } from "@noble/curves/secp256k1";

const evmNames = [
  "AQUA_AGENT_KEY",
  "AQUA_FACILITATOR_KEY",
  "AQUA_KEEPER_KEY",
  "AQUA_DEPLOYER_PRIVATE_KEY",
  "AQUA_FIXTURE_MAKER_KEY",
  "AQUA_DEPLOY_SIGNING_KEY",
] as const;

initializeCubane();

const missing: string[] = [];
for (const name of evmNames) {
  const value = Bun.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    missing.push(name);
    continue;
  }
  const key = hexSchema.parse(value);
  const address = signingKeyAddress(key);
  const publicKey = bytesToHex(secp256k1.getPublicKey(hexToBytes(key), true));
  console.log(`${name}\n  address    ${address}\n  publicKey  ${publicKey}\n`);
}

const paseto = Bun.env["PASETO_V4_SECRET_KEY"]?.trim();
if (paseto === undefined || paseto.length === 0) {
  missing.push("PASETO_V4_SECRET_KEY");
} else {
  if (!/^k4\.secret\.[A-Za-z0-9_-]{86}$/u.test(paseto)) throw new Error("PASETO_V4_SECRET_KEY is not a k4.secret PASERK");
  const secretBytes = Buffer.from(paseto.slice("k4.secret.".length), "base64url");
  if (secretBytes.length !== 64) throw new Error("PASETO secret key length is invalid");
  const publicKey = `k4.public.${Buffer.from(secretBytes.subarray(32)).toString("base64url")}`;
  console.log(`PASETO_V4_SECRET_KEY\n  publicKey  ${publicKey}\n`);
}

if (missing.length > 0) {
  console.error(`unset: ${missing.join(", ")}`);
}
