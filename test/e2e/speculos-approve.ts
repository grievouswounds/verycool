import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const base = new URL(Bun.env["AQUA_SPECULOS_URL"] ?? "http://127.0.0.1:5000");
const transcript = Bun.env["AQUA_SPECULOS_APPROVAL_LOG"];
const stop = Bun.env["AQUA_SPECULOS_APPROVAL_STOP"];
if (transcript === undefined || stop === undefined) throw new Error("Speculos approval environment is incomplete");

let previous = "";
let reviewing = false;
while (!await Bun.file(stop).exists()) {
  try {
    const response = await fetch(new URL("/events?currentscreenonly=true", base), { signal: AbortSignal.timeout(1_000) });
    const text = await response.text();
    const fingerprint = createHash("sha256").update(text).digest("hex");
    if (response.ok && fingerprint !== previous) {
      previous = fingerprint;
      await appendFile(transcript, `${JSON.stringify({ at: new Date().toISOString(), events: JSON.parse(text) as unknown })}\n`);
      const normalized = text.toLowerCase();
      let button: "both" | "right" | null = null;
      if (/sign message|sign typed|approve|accept and|confirm and|hold to sign/u.test(normalized)) {
        button = "both";
        reviewing = false;
      } else if (/review|continue|allow/u.test(normalized)) {
        button = "both";
        reviewing = true;
      } else if (reviewing) button = "right";
      if (button !== null) await fetch(new URL(`/button/${button}`, base), { method: "POST", signal: AbortSignal.timeout(1_000) });
    }
  } catch { /* The emulator may be between screens. */ }
  await Bun.sleep(100);
}
