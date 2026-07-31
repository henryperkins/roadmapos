import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, executionPlans, ExecutionRepository } from "../src/index.js";
import { resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabase(url);

beforeEach(async () => resetTestDatabase(url));

describe("execution workflow persistence", () => {
  it("rejects mutation of an execution plan", async () => {
    const fixture = await seedExecutionFixture(database);
    await database.db.insert(executionPlans).values({
      id: fixture.planId,
      runId: fixture.runId,
      version: 1,
      planJson: { steps: ["change parser"] },
      contentHash: "a".repeat(64),
      baseSha: "b".repeat(40),
      changeClassification: "initial"
    });
    await expect(database.sql`UPDATE execution_plans SET version = 2 WHERE id = ${fixture.planId}::uuid`).rejects.toThrow("immutable table execution_plans");
  });

  it("rejects direct run-state writes and accepts reducer-governed transitions", async () => {
    const fixture = await seedExecutionFixture(database, { runState: "registered", condition: "governed_orchestration" });
    await expect(database.sql`UPDATE runs SET state = 'completed' WHERE id = ${fixture.runId}::uuid`).rejects.toThrow("ExecutionRepository");
    const next = await new ExecutionRepository(database).transition({
      runId: fixture.runId,
      event: { type: "analysis_started" },
      actorType: "system",
      actorId: "test"
    });
    expect(next).toBe("planning");
  });
});
