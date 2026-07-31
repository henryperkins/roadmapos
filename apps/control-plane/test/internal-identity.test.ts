import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, internalAccessTokens, judgmentComparisons, pilotEvents } from "@roadmapos/db";
import { DeterministicFakeAgentGateway } from "@roadmapos/agent";
import { resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";
import { CheckpointService } from "../src/services/checkpoint-service.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");

beforeEach(async () => resetTestDatabase(url));

const continueClassification = {
  boundary: "none",
  planRelationship: "within_plan",
  decision: "continue",
  affectedPolicyRules: [],
  facts: ["Within plan"],
  requiredDisclosureFields: [],
  reversible: true,
  confidence: 90,
  rationale: "Within the approved authorization"
};

describe("internal session identity", () => {
  it("attributes the reveal to the bound participant, not to a shared role name", async () => {
    const database = createDatabase(url);
    const fixture = await seedExecutionFixture(database);
    const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
    const service = new CheckpointService(database, agent, Buffer.alloc(32, 21).toString("base64"));
    const checkpoint = await service.freeze(fixture.checkpointInput);
    const app = await buildApp(fixture.controlPlaneConfig({ databaseUrl: url, checkpointService: service }));

    const response = await app.inject({
      method: "POST",
      url: `/internal/operator/checkpoints/${checkpoint.id}/classification`,
      headers: { authorization: `Bearer ${fixture.operatorToken}` },
      payload: continueClassification
    });
    expect(response.statusCode).toBe(201);

    const events = await database.db.select().from(pilotEvents).where(eq(pilotEvents.pilotId, fixture.pilotId));
    const reveal = events.find((event) => event.eventType === "checkpoint.revealed");
    expect(reveal?.actorId).toBe(fixture.operatorParticipantId);
    expect(reveal?.actorId).not.toBe("operator");
    await app.close();
    await database.close();
  });

  it("refuses a revoked token", async () => {
    const database = createDatabase(url);
    const fixture = await seedExecutionFixture(database);
    const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
    const service = new CheckpointService(database, agent, Buffer.alloc(32, 22).toString("base64"));
    const checkpoint = await service.freeze(fixture.checkpointInput);
    const app = await buildApp(fixture.controlPlaneConfig({ databaseUrl: url, checkpointService: service }));

    await database.db.update(internalAccessTokens).set({ revokedAt: new Date() })
      .where(eq(internalAccessTokens.participantId, fixture.operatorParticipantId));

    const response = await app.inject({
      method: "GET",
      url: `/internal/operator/checkpoints/${checkpoint.id}`,
      headers: { authorization: `Bearer ${fixture.operatorToken}` }
    });
    expect(response.statusCode).toBe(401);
    await app.close();
    await database.close();
  });

  it("refuses an operator bound to a different pilot", async () => {
    const database = createDatabase(url);
    const owning = await seedExecutionFixture(database);
    const other = await seedExecutionFixture(database, { issueNumberOffset: 50 });
    const agent = new DeterministicFakeAgentGateway(owning.planDraft, [], owning.classifier);
    const service = new CheckpointService(database, agent, Buffer.alloc(32, 23).toString("base64"));
    const checkpoint = await service.freeze(owning.checkpointInput);
    const app = await buildApp(owning.controlPlaneConfig({ databaseUrl: url, checkpointService: service }));

    const read = await app.inject({
      method: "GET",
      url: `/internal/operator/checkpoints/${checkpoint.id}`,
      headers: { authorization: `Bearer ${other.operatorToken}` }
    });
    expect(read.statusCode).toBe(403);

    const write = await app.inject({
      method: "POST",
      url: `/internal/operator/checkpoints/${checkpoint.id}/classification`,
      headers: { authorization: `Bearer ${other.operatorToken}` },
      payload: continueClassification
    });
    expect(write.statusCode).toBe(403);
    const comparisons = await database.db.select().from(judgmentComparisons).where(eq(judgmentComparisons.checkpointId, checkpoint.id));
    expect(comparisons).toHaveLength(0);

    await app.close();
    await database.close();
  });

  it("refuses an auditor at the operator gate and permits the pilot's own operator", async () => {
    const database = createDatabase(url);
    const fixture = await seedExecutionFixture(database);
    const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
    const service = new CheckpointService(database, agent, Buffer.alloc(32, 24).toString("base64"));
    const checkpoint = await service.freeze(fixture.checkpointInput);
    const app = await buildApp(fixture.controlPlaneConfig({ databaseUrl: url, checkpointService: service }));

    const auditor = await app.inject({
      method: "GET",
      url: `/internal/operator/checkpoints/${checkpoint.id}`,
      headers: { authorization: `Bearer ${fixture.auditorToken}` }
    });
    expect(auditor.statusCode).toBe(403);

    const operator = await app.inject({
      method: "GET",
      url: `/internal/operator/checkpoints/${checkpoint.id}`,
      headers: { authorization: `Bearer ${fixture.operatorToken}` }
    });
    expect(operator.statusCode).toBe(200);
    await app.close();
    await database.close();
  });
});
