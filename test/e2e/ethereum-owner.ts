import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { recoverPersonalAddress } from "@aqua/evm";
import { ledgerOwnerAddress, signLedgerMessage } from "../../apps/mcp-bridge/src/ledger.ts";

const output = Bun.env["AQUA_E2E_REPORT"];
if (output === undefined) throw new Error("AQUA_E2E_REPORT is required");
const owner = await ledgerOwnerAddress();
const message = `localhost wants you to sign in with your Ethereum account:\n${owner}\n\nAqua Speculos E2E owner proof`;
const signature = await signLedgerMessage(owner, message);
const recovered = recoverPersonalAddress(message, signature);
if (recovered.toLowerCase() !== owner.toLowerCase()) throw new Error("Ledger SIWE-style signature recovered to the wrong owner");
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, `${JSON.stringify({ owner, recoveredSigner: recovered, siweStyleMessageSigned: true }, null, 2)}\n`);
