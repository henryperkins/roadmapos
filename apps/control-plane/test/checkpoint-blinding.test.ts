import { beforeEach, expect, it } from "vitest";
import { createDatabase } from "@roadmapos/db";
import { DeterministicFakeAgentGateway } from "@roadmapos/agent";
import { resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";
import { CheckpointService } from "../src/services/checkpoint-service.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");

beforeEach(async () => resetTestDatabase(url));

it("withholds the agent classification until the operator submits", async () => {
  const database = createDatabase(url);
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration" });
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], () => ({
    boundary: "none",
    planRelationship: "materially_equivalent_variation",
    decision: "continue",
    affectedPolicyRules: [],
    facts: ["The behavior remains within approved intent"],
    requiredDisclosureFields: ["actual implementation variation"],
    reversible: true,
    confidence: 88
  }));
  const service = new CheckpointService(database, agent, Buffer.alloc(32, 3).toString("base64"));
  const checkpoint = await service.freeze(fixture.checkpointInput);

  const app = await buildApp(fixture.controlPlaneConfig({ databaseUrl: url, checkpointService: service }));
  const before = await app.inject({ method: "GET", url: `/internal/operator/checkpoints/${checkpoint.id}`, headers: { authorization: "Bearer hi" } });
  expect(before.statusCode).toBe(200);
  const body = before.json<Record<string, unknown>>();
  expect(body.agentClassification).toBeUndefined();
  expect(body.sealedPayload).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("materially_equivalent_variation");
  expect(body.agentClassificationCommitted).toBe(true);
  expect((body.checkpoint as { packageHash: string }).packageHash).toBe(checkpoint.packageHash);

  const after = await app.inject({
    method: "POST",
    url: `/internal/operator/checkpoints/${checkpoint.id}/classification`,
    headers: { authorization: "Bearer hi" },
    payload: {
      boundary: "repository_protected",
      planRelationship: "material_scope_expansion",
      decision: "pause_and_escalate",
      affectedPolicyRules: ["protected_zone:src/auth/**"],
      facts: ["The patch changes authentication behavior"],
      requiredDisclosureFields: ["affected protected zone"],
      reversible: true,
      confidence: 95,
      rationale: "Maintainer approval is required"
    }
  });
  expect(after.statusCode).toBe(201);
  expect(after.json<{ comparison: { unsafeFalseNegative: boolean } }>().comparison.unsafeFalseNegative).toBe(true);
  await app.close();
  await database.close();
});

it("refuses an auditor and an unauthenticated caller at the operator gate", async () => {
  const database = createDatabase(url);
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration" });
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
  const service = new CheckpointService(database, agent, Buffer.alloc(32, 5).toString("base64"));
  const checkpoint = await service.freeze(fixture.checkpointInput);
  const app = await buildApp(fixture.controlPlaneConfig({ databaseUrl: url, checkpointService: service }));

  const auditor = await app.inject({ method: "GET", url: `/internal/operator/checkpoints/${checkpoint.id}`, headers: { authorization: "Bearer bye-auditor" } });
  expect(auditor.statusCode).toBe(403);
  const anonymous = await app.inject({ method: "GET", url: `/internal/operator/checkpoints/${checkpoint.id}` });
  expect(anonymous.statusCode).toBe(401);
  await app.close();
  await database.close();
});

it("rejects a second reveal of the same checkpoint", async () => {
  const database = createDatabase(url);
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration" });
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
  const service = new CheckpointService(database, agent, Buffer.alloc(32, 6).toString("base64"));
  const checkpoint = await service.freeze(fixture.checkpointInput);
  const submission = {
    checkpointId: checkpoint.id,
    operatorId: "operator-1",
    rationale: "Within the approved plan",
    classification: {
      boundary: "none" as const,
      planRelationship: "within_plan" as const,
      decision: "continue" as const,
      affectedPolicyRules: [],
      facts: ["Within plan"],
      requiredDisclosureFields: [],
      reversible: true,
      confidence: 90
    }
  };
  await service.recordOperatorClassification(submission);
  await expect(service.recordOperatorClassification(submission)).rejects.toThrow("already revealed");
  await database.close();
});

it("rejects an operator attempt to continue through a platform hard stop", async () => {
  const database = createDatabase(url);
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], () => ({
    boundary: "platform_hard_stop",
    planRelationship: "within_plan",
    decision: "stop",
    affectedPolicyRules: ["platform:merge"],
    facts: ["The contemplated action is a merge"],
    requiredDisclosureFields: [],
    reversible: false,
    confidence: 100
  }));
  const service = new CheckpointService(database, agent, Buffer.alloc(32, 4).toString("base64"));
  const checkpoint = await service.freeze({
    ...fixture.checkpointInput,
    package: {
      ...fixture.checkpointInput.package,
      policyEvaluation: { boundary: "platform_hard_stop", requiresEscalation: false, matchedRules: ["platform:merge"] }
    }
  });
  await expect(service.recordOperatorClassification({
    checkpointId: checkpoint.id,
    operatorId: "operator-1",
    rationale: "Override the hard stop",
    classification: {
      boundary: "none",
      planRelationship: "within_plan",
      decision: "continue",
      affectedPolicyRules: ["platform:merge"],
      facts: ["The operator wants to continue"],
      requiredDisclosureFields: [],
      reversible: false,
      confidence: 100
    }
  })).rejects.toThrow("Frozen policy evaluation requires stop");
  await database.close();
});

it("rejects an operator continue through a frozen repository-protected boundary", async () => {
  const database = createDatabase(url);
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
  const service = new CheckpointService(database, agent, Buffer.alloc(32, 7).toString("base64"));
  const checkpoint = await service.freeze({
    ...fixture.checkpointInput,
    package: {
      ...fixture.checkpointInput.package,
      policyEvaluation: { boundary: "repository_protected", requiresEscalation: true, matchedRules: ["protected_zone:src/auth/**"] }
    }
  });
  await expect(service.recordOperatorClassification({
    checkpointId: checkpoint.id,
    operatorId: "operator-1",
    rationale: "Looks fine to me",
    classification: {
      boundary: "none",
      planRelationship: "within_plan",
      decision: "continue",
      affectedPolicyRules: [],
      facts: ["The operator wants to continue"],
      requiredDisclosureFields: [],
      reversible: true,
      confidence: 60
    }
  })).rejects.toThrow("Frozen policy evaluation requires escalation or stop");
  await database.close();
});

it("requires a frozen deterministic policy evaluation on every live action checkpoint", async () => {
  const database = createDatabase(url);
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration" });
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
  const service = new CheckpointService(database, agent, Buffer.alloc(32, 8).toString("base64"));
  const { policyEvaluation: _dropped, ...withoutEvaluation } = fixture.checkpointInput.package;
  await expect(service.freeze({ ...fixture.checkpointInput, package: withoutEvaluation }))
    .rejects.toThrow("require a frozen deterministic policy evaluation");
  await database.close();
});
