import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { addressSchema } from "@aqua/core";
import type { Eip712TypedData } from "@aqua/evm";
import { recoverPersonalAddress, recoverTypedDataAddress } from "@aqua/evm";
import { ledgerOwnerAddress, signLedgerMessage, signLedgerTypedData } from "../../apps/mcp-bridge/src/ledger.ts";

const output = Bun.env["AQUA_E2E_REPORT"];
if (output === undefined) throw new Error("AQUA_E2E_REPORT is required");
const owner = await ledgerOwnerAddress();
const message = `localhost wants you to sign in with your Ethereum account:\n${owner}\n\nAqua Speculos E2E owner proof`;
const signature = await signLedgerMessage(owner, message);
const recovered = recoverPersonalAddress(message, signature);
if (recovered.toLowerCase() !== owner.toLowerCase()) throw new Error("Ledger SIWE-style signature recovered to the wrong owner");
const verifyingContract = addressSchema.parse("0x1111111111111111111111111111111111111111");
const typedData: Eip712TypedData = {
  domain: { name: "Aqua Ledger Agent Vault", version: "1", chainId: 31337, verifyingContract },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ],
    Delegation: [
      { name: "owner", type: "address" }, { name: "delegate", type: "address" }, { name: "token", type: "address" },
      { name: "maxPerOrder", type: "uint256" }, { name: "maxPerDay", type: "uint256" }, { name: "validUntil", type: "uint256" }, { name: "nonce", type: "uint256" },
    ],
  },
  primaryType: "Delegation",
  message: {
    owner, delegate: owner, token: verifyingContract,
    maxPerOrder: "100", maxPerDay: "200", validUntil: "9999999999", nonce: "0",
  },
};
const typedSignature = await signLedgerTypedData(owner, typedData);
const typedRecovered = recoverTypedDataAddress(typedData, typedSignature);
if (typedRecovered.toLowerCase() !== owner.toLowerCase()) throw new Error("Ledger EIP-712 signature recovered to the wrong owner");
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, `${JSON.stringify({ owner, recoveredSigner: recovered, siweStyleMessageSigned: true, eip712DelegationSigned: true }, null, 2)}\n`);
