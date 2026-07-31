import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendAuditEvent, createDatabase, enqueueJob, jobs, pilotEvents, pilotStudies } from "../src/index.js";
import { eq } from "drizzle-orm";
import { resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");

beforeEach(async () => resetTestDatabase(url));

/**
 * `drizzle(sql)` mutates the shared postgres client's type serializers, which breaks `sql.json()`
 * and `transaction.json()` at bind time on that same client. Milestone 1 hit this in production
 * code, so these tests initialize Drizzle first and then drive every raw JSONB write path.
 */
describe("raw JSONB writes after Drizzle initialization", () => {
  it("writes an audit payload through a client whose serializers Drizzle already mutated", async () => {
    const database = createDatabase(url);
    // Touch the Drizzle query builder first so the serializer mutation is definitely in effect.
    await database.db.select().from(pilotStudies);

    const pilotId = crypto.randomUUID();
    await database.db.insert(pilotStudies).values({ id: pilotId, name: "Serializer", status: "draft" });
    const event = await appendAuditEvent(database, {
      pilotId,
      eventType: "pilot.created",
      actorType: "operator",
      actorId: "operator-1",
      payload: { nested: { object: true }, list: [1, 2, 3] }
    });
    expect(event.sequence).toBe(1);
    const [row] = await database.db.select().from(pilotEvents).where(eq(pilotEvents.id, event.id));
    expect(row?.payload).toEqual({ nested: { object: true }, list: [1, 2, 3] });
    await database.close();
  });

  it("enqueues a job with an object payload after Drizzle initialization", async () => {
    const database = createDatabase(url);
    await database.db.select().from(jobs);
    const jobId = await enqueueJob(database, "fixture", { runId: "abc", nested: { deep: [1] } });
    const [row] = await database.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row?.payload).toEqual({ runId: "abc", nested: { deep: [1] } });
    await database.close();
  });

  it("writes sealed classifications and comparisons through raw SQL after Drizzle initialization", async () => {
    const database = createDatabase(url);
    const fixture = await seedExecutionFixture(database);
    const checkpointId = crypto.randomUUID();
    const sealed = { version: 1, iv: "aXY=", tag: "dGFn", ciphertext: "Y2lwaGVy" };
    const classification = { boundary: "none", decision: "continue", facts: ["a"] };

    await database.sql`
      INSERT INTO governance_checkpoints (id, run_id, source, package_json, package_hash)
      VALUES (${checkpointId}::uuid, ${fixture.runId}::uuid, 'challenge', ${JSON.stringify(fixture.checkpointInput.package)}::jsonb, ${"e".repeat(64)})
    `;
    await database.sql`
      INSERT INTO judgment_classifications (id, checkpoint_id, actor_type, sealed_payload, payload_hash)
      VALUES (${crypto.randomUUID()}::uuid, ${checkpointId}::uuid, 'agent', ${JSON.stringify(sealed)}::jsonb, ${"f".repeat(64)})
    `;
    await database.sql`
      INSERT INTO judgment_comparisons
        (id, checkpoint_id, agent_payload, operator_payload, decision_agreement, boundary_agreement, unsafe_false_negative, conservative_false_positive)
      VALUES
        (${crypto.randomUUID()}::uuid, ${checkpointId}::uuid, ${JSON.stringify(classification)}::jsonb, ${JSON.stringify(classification)}::jsonb, true, true, false, false)
    `;

    const [stored] = await database.sql<{ sealed_payload: unknown }[]>`
      SELECT sealed_payload FROM judgment_classifications WHERE checkpoint_id = ${checkpointId}::uuid
    `;
    expect(stored?.sealed_payload).toEqual(sealed);
    await database.close();
  });

  it("keeps the postgres client's json helper out of every workspace source file", async () => {
    const root = join(fileURLToPath(new URL("../../..", import.meta.url)));
    const offenders: string[] = [];
    for (const directory of ["packages", "apps"]) {
      for await (const file of walk(join(root, directory))) {
        if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
        // Comments are stripped so prose naming the forbidden call is not itself a violation.
        const source = (await readFile(file, "utf8"))
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (/\b(?:sql|transaction|tx)\.json\s*\(/.test(source)) offenders.push(file.slice(root.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});

async function* walk(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}
