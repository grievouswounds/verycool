import { existsSync } from "node:fs";

if (!existsSync(".env")) {
  throw new Error("Missing .env. Copy .env.example to .env and configure the chain contracts before starting the API.");
}

await import("../apps/api/src/main.ts");
