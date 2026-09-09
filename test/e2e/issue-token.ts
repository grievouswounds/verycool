import { readFile } from "node:fs/promises";
import { addressSchema } from "@aqua/core";
import { SecretBrokerClient } from "@aqua/security";
import { z } from "zod";

const socket = Bun.env["AQUA_BROKER_SOCKET"];
const ownerEvidence = Bun.env["AQUA_LEDGER_OWNER_EVIDENCE"];
if (socket === undefined || ownerEvidence === undefined) throw new Error("Token issuer environment is incomplete");
const { owner } = z.object({ owner: addressSchema }).loose().parse(JSON.parse(await readFile(ownerEvidence, "utf8")));
const broker = new SecretBrokerClient(socket);
const token = await broker.issuePaseto({
  address: owner,
  sessionId: crypto.randomUUID(),
  scopes: ["trading:read", "trading:write", "activity:read", "activity:write"],
  amr: ["fido2", "hwk"],
  clientId: "aqua-e2e-mcp",
});
process.stdout.write(token);
