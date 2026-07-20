import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";

export async function resetTestDatabase(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const directory = new URL("../../db/src/migrations", import.meta.url).pathname;
  for (const name of (await readdir(directory)).filter((value) => value.endsWith(".sql")).sort()) {
    await sql.unsafe(await readFile(`${directory}/${name}`, "utf8"));
  }
  await sql.end();
}
