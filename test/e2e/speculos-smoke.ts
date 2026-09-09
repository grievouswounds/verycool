import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const url = new URL(Bun.env["AQUA_SPECULOS_URL"] ?? "http://127.0.0.1:5000");
const app = Bun.env["AQUA_SPECULOS_APP"];
const elf = Bun.env["AQUA_SPECULOS_ELF"];
const out = Bun.env["AQUA_SPECULOS_EVIDENCE"];
const probe = Bun.env["AQUA_SPECULOS_PROBE_APDU"] ?? "";
const expected = Bun.env["AQUA_SPECULOS_PROBE_EXPECT"] ?? "";
if (app === undefined || elf === undefined || out === undefined) {
  throw new Error("Speculos smoke evidence environment is incomplete");
}
let applicationInfoApdu: string | undefined;
if (probe !== "") {
  const response = await fetch(new URL("/apdu", url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: probe }),
  });
  if (!response.ok) throw new Error(`${app} Speculos APDU returned HTTP ${String(response.status)}`);
  const body = await response.json() as { readonly data?: string };
  if (typeof body.data !== "string" || !body.data.toLowerCase().endsWith("9000")
    || !body.data.toLowerCase().includes(expected.toLowerCase())) throw new Error(`${app} rejected its application-specific APDU`);
  applicationInfoApdu = body.data;
}
const eventsResponse = await fetch(new URL("/events?currentscreenonly=true", url));
if (!eventsResponse.ok) throw new Error(`${app} Speculos events endpoint failed`);
const bytes = await readFile(elf);
await Bun.write(out, `${JSON.stringify({
  app, elfSha256: createHash("sha256").update(bytes).digest("hex"),
  probeName: Bun.env["AQUA_SPECULOS_PROBE_NAME"] ?? "application-info",
  ...(applicationInfoApdu === undefined ? {} : { applicationInfoApdu }),
  eventsJson: await eventsResponse.text(),
}, null, 2)}\n`);
