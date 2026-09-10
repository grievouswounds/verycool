import { z } from "zod";

const url = new URL(Bun.env["AQUA_SPECULOS_URL"] ?? "http://127.0.0.1:5000");
const screenSchema = z.object({
  events: z.array(z.object({ text: z.unknown().optional() }).loose()).optional(),
}).loose();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const currentScreen = async (): Promise<string> => {
  const body = screenSchema.parse(await (await fetch(new URL("/events?currentscreenonly=true", url))).json());
  const events = body.events ?? [];
  return events.map((event) => String(event.text ?? "").trim()).filter((line) => line.length > 0).join("\n");
};

const press = async (button: "left" | "right" | "both"): Promise<void> => {
  const response = await fetch(new URL(`/button/${button}`, url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "press-and-release" }),
  });
  if (!response.ok) throw new Error(`Speculos button ${button} returned HTTP ${String(response.status)}`);
};

const until = async (label: string, match: (text: string) => boolean, action: () => Promise<void>): Promise<string> => {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const text = await currentScreen();
    if (text.length > 0) console.error(`Speculos ${label}:\n${text}`);
    if (match(text)) return text;
    await action();
    await sleep(250);
  }
  throw new Error(`Ethereum app did not reach ${label}; last screen:\n${await currentScreen()}`);
};

const lowered = (text: string): string => text.toLowerCase();
await until("home", (text) => lowered(text).includes("app is ready"), async () => sleep(250));
await until("settings", (text) => /app settings|settings/i.test(text) && !/blind/i.test(text), async () => press("right"));
await press("both");
await sleep(300);
const settings = await until("blind signing", (text) => /blind signing/i.test(text), async () => press("right"));
if (!/enabled/i.test(lowered(settings))) {
  await press("both");
  await sleep(300);
}
const confirmed = await currentScreen();
console.error(`Speculos blind-signing setting:\n${confirmed}`);
if (!/enabled/i.test(lowered(confirmed)) && !/enabled/i.test(lowered(settings))) {
  throw new Error(`Ethereum blind signing is not enabled; last screen:\n${confirmed}`);
}
for (let attempt = 0; attempt < 4; attempt += 1) {
  await press("left");
  await sleep(250);
  if (lowered(await currentScreen()).includes("app is ready")) break;
}
export {};
