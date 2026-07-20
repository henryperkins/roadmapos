import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appendAuditEvent, createDatabase, enqueueJob, claimNextJob, pilotEvents, pilotStudies } from "../src/index.js";
import { resetTestDatabase } from "@roadmapos/testkit";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabase(url);

beforeAll(async () => resetTestDatabase(url));
afterAll(async () => database.close());

describe("governance persistence", () => {
  it("creates a tamper-evident event chain", async () => {
    const pilotId = crypto.randomUUID();
    await database.db.insert(pilotStudies).values({ id: pilotId, name: "Pilot A", status: "draft" });

    const first = await appendAuditEvent(database, {
      pilotId,
      eventType: "pilot.created",
      actorType: "operator",
      actorId: "operator-1",
      payload: { name: "Pilot A" }
    });
    const second = await appendAuditEvent(database, {
      pilotId,
      eventType: "repository.registered",
      actorType: "operator",
      actorId: "operator-1",
      payload: { owner: "acme", name: "widget" }
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.eventHash);
    const rows = await database.db.select().from(pilotEvents).where(eq(pilotEvents.pilotId, pilotId));
    expect(rows).toHaveLength(2);
  });

  it("claims each queued job once", async () => {
    const jobId = await enqueueJob(database, "fixture", { value: 1 });
    const claimed = await claimNextJob(database, "worker-a", ["fixture"]);
    expect(claimed?.id).toBe(jobId);
    expect(await claimNextJob(database, "worker-b", ["fixture"])).toBeNull();
  });
});
