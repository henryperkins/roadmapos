import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = postgres(url, { max: 1 });
const directory = new URL("./migrations", import.meta.url).pathname;

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
for (const name of (await readdir(directory)).filter((value) => value.endsWith(".sql")).sort()) {
  const [existing] = await sql<{ name: string }[]>`SELECT name FROM schema_migrations WHERE name = ${name}`;
  if (existing) continue;
  const source = await readFile(join(directory, name), "utf8");
  await sql.begin(async (transaction) => {
    await transaction.unsafe(source);
    await transaction`INSERT INTO schema_migrations (name) VALUES (${name})`;
  });
}
await sql.end();
