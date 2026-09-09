import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const base = new URL(Bun.env["AQUA_SPECULOS_URL"] ?? "http://127.0.0.1:5000");
const transcript = Bun.env["AQUA_SPECULOS_APPROVAL_LOG"];
const stop = Bun.env["AQUA_SPECULOS_APPROVAL_STOP"];
if (transcript === undefined || stop === undefined) throw new Error("Speculos approval environment is incomplete");

const screenText = (payload: string): string => {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === "object" && parsed !== null && "events" in parsed && Array.isArray(parsed.events)) {
      return parsed.events.map((event: unknown) => {
        if (typeof event === "object" && event !== null && "text" in event && typeof event.text === "string") return event.text;
        return "";
      }).join("\n");
    }
  } catch { /* Speculos may return an empty body between screens. */ }
  return payload;
};

const press = async (button: "left" | "right" | "both", delay: number): Promise<void> => {
  await fetch(new URL(`/button/${button}`, base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "press-and-release", delay }),
    signal: AbortSignal.timeout(5_000),
  });
};

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
      const normalized = screenText(text).toLowerCase();
      if (/hold to sign|hold to approve|sign this|sign message|sign typed|approve|accept|confirm/u.test(normalized)) {
        reviewing = false;
        await press("both", /hold/u.test(normalized) ? 3 : 0.2);
      } else if (/review|continue|allow|message|typed data|e ?ip.?712/u.test(normalized)) {
        reviewing = true;
        await press("both", 0.1);
      } else if (reviewing) await press("right", 0.1);
    }
  } catch { /* The emulator may be between screens. */ }
  await Bun.sleep(100);
}
