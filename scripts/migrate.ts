import { SQL } from "bun";

const url = Bun.env["DATABASE_URL"];
if (url === undefined || url.length === 0) throw new Error("DATABASE_URL is required");
const database = new SQL(url);
try {
  await database`SELECT pg_advisory_lock(82193341)`;
  await database`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const files = (await Array.fromAsync(new Bun.Glob("*.sql").scan({ cwd: "packages/adapters/migrations" }))).toSorted();
  for (const file of files) {
    const existing = await database<readonly { readonly version: string }[]>`SELECT version FROM schema_migrations WHERE version = ${file}`;
    if (existing.length !== 0) continue;
    const source = await Bun.file(`packages/adapters/migrations/${file}`).text();
    await database.begin(async (transaction) => {
      await transaction.unsafe(source);
      await transaction`INSERT INTO schema_migrations (version) VALUES (${file})`;
    });
  }
} finally { await database.close(); }
