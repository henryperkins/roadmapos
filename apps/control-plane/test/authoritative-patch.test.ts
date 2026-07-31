import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, governanceCheckpoints } from "@roadmapos/db";
import { DeterministicFakeAgentGateway } from "@roadmapos/agent";
import { CheckpointPackageSchema, type ActionProposal } from "@roadmapos/domain";
import { FakeGitHubGateway, FakeWorkspaceRunner, resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";
import { CheckpointService } from "../src/services/checkpoint-service.js";
import { ActionCoordinator } from "../src/services/action-coordinator.js";
import { ApprovalService } from "../src/services/approval-service.js";
import { WorkspaceService } from "../src/services/workspace-service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabase(url);

beforeEach(async () => resetTestDatabase(url));

function patchFor(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
}

async function harness(action: ActionProposal) {
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
  const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
  const planId = crypto.randomUUID();
  await database.sql`
    INSERT INTO execution_plans (id, run_id, version, plan_json, content_hash, base_sha, change_classification)
    VALUES (${planId}::uuid, ${fixture.runId}::uuid, 1, ${JSON.stringify(fixture.planDraft)}::jsonb, ${"d".repeat(64)}, ${fixture.baseSha}, 'initial')
  `;
  await database.sql`UPDATE runs SET current_plan_id = ${planId}::uuid WHERE id = ${fixture.runId}::uuid`;
  await new ApprovalService(database, github).approvePlan({
    runId: fixture.runId, version: 1, hashPrefix: "d".repeat(16),
    githubUserId: "41", githubLogin: "maintainer-a", githubCommentId: "600"
  });
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [action], fixture.classifier);
  const checkpoints = new CheckpointService(database, agent, Buffer.alloc(32, 41).toString("base64"));
  const runner = new FakeWorkspaceRunner();
  const coordinator = new ActionCoordinator(
    database, agent, checkpoints, runner, github, fixture.publicBaseUrl,
    new WorkspaceService(database, github, runner), new ApprovalService(database, github)
  );
  return { fixture, coordinator, checkpoints, runner, github };
}

describe("policy decisions derive from the patch, not its description", () => {
  it("rejects a patch that understates which files it touches", async () => {
    const { fixture, coordinator } = await harness({
      kind: "apply_patch" as const,
      // Declares the parser, actually edits protected authentication code.
      patch: patchFor("src/auth/session.ts"),
      summary: "Tidy the parser",
      affectedPaths: ["src/parser.ts"],
      discoveredFacts: ["Parser cleanup"],
      changesPublicInterface: false,
      changesDependencies: false,
      changesSecurityBehavior: false
    });

    await expect(coordinator.propose(fixture.runId)).rejects.toThrow("does not match its own description");
    const frozen = await database.db.select().from(governanceCheckpoints).where(eq(governanceCheckpoints.runId, fixture.runId));
    expect(frozen).toHaveLength(0);
  });

  it("catches a protected zone from the diff even when the description looks innocuous", async () => {
    const { fixture, coordinator } = await harness({
      kind: "apply_patch" as const,
      patch: patchFor("src/auth/session.ts"),
      summary: "Small change",
      affectedPaths: ["src/auth/session.ts"],
      discoveredFacts: ["Small change"],
      changesPublicInterface: false,
      changesDependencies: false,
      changesSecurityBehavior: false
    });

    const proposal = await coordinator.propose(fixture.runId);
    const [checkpoint] = await database.db.select().from(governanceCheckpoints).where(eq(governanceCheckpoints.id, String(proposal.checkpointId)));
    const frozen = CheckpointPackageSchema.parse(checkpoint?.packageJson);
    expect(frozen.policyEvaluation?.boundary).toBe("repository_protected");
    expect(frozen.policyEvaluation?.matchedRules).toContain("protected_zone:src/auth/**");
    expect(frozen.policyEvaluation?.requiresEscalation).toBe(true);
  });

  it("escalates an understated dependency change and records the evidence beside the claim", async () => {
    const { fixture, coordinator } = await harness({
      kind: "apply_patch" as const,
      patch: patchFor("package.json"),
      summary: "Bump nothing important",
      affectedPaths: ["package.json"],
      discoveredFacts: ["Manifest tidy-up"],
      changesPublicInterface: false,
      changesDependencies: false,
      changesSecurityBehavior: false
    });

    const proposal = await coordinator.propose(fixture.runId);
    const [checkpoint] = await database.db.select().from(governanceCheckpoints).where(eq(governanceCheckpoints.id, String(proposal.checkpointId)));
    const frozen = CheckpointPackageSchema.parse(checkpoint?.packageJson);
    expect(frozen.policyEvaluation?.matchedRules).toContain("dependencies:additions_require_escalation");
    expect(frozen.discoveredFacts).toContain("derived:dependency_manifest_changed:package.json");
    expect(frozen.discoveredFacts.some((fact) => fact.startsWith("derived:understated_effect:changesDependencies"))).toBe(true);
  });

  it("freezes the derived paths and the derived patch hash, not the declared ones", async () => {
    const patch = patchFor("src/a.ts");
    const { fixture, coordinator } = await harness({
      kind: "apply_patch" as const,
      patch,
      summary: "Update A",
      affectedPaths: ["src/a.ts"],
      discoveredFacts: ["A needs updating"],
      changesPublicInterface: false,
      changesDependencies: false,
      changesSecurityBehavior: false
    });

    const proposal = await coordinator.propose(fixture.runId);
    const [checkpoint] = await database.db.select().from(governanceCheckpoints).where(eq(governanceCheckpoints.id, String(proposal.checkpointId)));
    const frozen = CheckpointPackageSchema.parse(checkpoint?.packageJson);
    expect(frozen.contemplatedAction.affectedPaths).toEqual(["src/a.ts"]);
    expect(frozen.contemplatedAction.patchHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses to apply a patch that is not the one the operator cleared", async () => {
    const { fixture, coordinator, checkpoints, runner } = await harness({
      kind: "apply_patch" as const,
      patch: patchFor("src/a.ts"),
      summary: "Update A",
      affectedPaths: ["src/a.ts"],
      discoveredFacts: ["A needs updating"],
      changesPublicInterface: false,
      changesDependencies: false,
      changesSecurityBehavior: false
    });
    const proposal = await coordinator.propose(fixture.runId);
    await checkpoints.recordOperatorClassification({
      checkpointId: String(proposal.checkpointId),
      operatorId: "operator-1",
      rationale: "Within the approved plan",
      classification: {
        boundary: "none", planRelationship: "within_plan", decision: "continue",
        affectedPolicyRules: [], facts: ["Within plan"], requiredDisclosureFields: [], reversible: true, confidence: 90
      }
    });

    // Swap the stored patch after the operator cleared it, the way a compromised queue would.
    await database.sql`
      UPDATE action_proposals
      SET action_json = jsonb_set(action_json, '{patch}', ${JSON.stringify(patchFor("src/b.ts"))}::jsonb)
      WHERE id = ${proposal.proposalId}::uuid
    `;

    await expect(coordinator.executeAfterGate(fixture.runId, proposal.proposalId))
      .rejects.toThrow("not the patch the operator cleared");
    expect(runner.appliedPatches).toHaveLength(0);
  });
});

it("refuses to freeze a checkpoint when branch protection cannot be read authoritatively", async () => {
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
  const github = new FakeGitHubGateway({
    permission: "maintain",
    branchHead: fixture.baseSha,
    branchProtection: { enabled: false, requiredApprovals: 0, determinacy: "indeterminate", reason: "no Administration: read" }
  });
  const planId = crypto.randomUUID();
  await database.sql`
    INSERT INTO execution_plans (id, run_id, version, plan_json, content_hash, base_sha, change_classification)
    VALUES (${planId}::uuid, ${fixture.runId}::uuid, 1, ${JSON.stringify(fixture.planDraft)}::jsonb, ${"d".repeat(64)}, ${fixture.baseSha}, 'initial')
  `;
  await database.sql`UPDATE runs SET current_plan_id = ${planId}::uuid WHERE id = ${fixture.runId}::uuid`;
  const action: ActionProposal = {
    kind: "apply_patch",
    patch: patchFor("src/a.ts"),
    summary: "Update A",
    affectedPaths: ["src/a.ts"],
    discoveredFacts: ["A needs updating"],
    changesPublicInterface: false,
    changesDependencies: false,
    changesSecurityBehavior: false
  };
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [action], fixture.classifier);
  const checkpoints = new CheckpointService(database, agent, Buffer.alloc(32, 42).toString("base64"));
  const runner = new FakeWorkspaceRunner();
  const coordinator = new ActionCoordinator(
    database, agent, checkpoints, runner, github, fixture.publicBaseUrl,
    new WorkspaceService(database, github, runner), new ApprovalService(database, github)
  );

  await expect(coordinator.propose(fixture.runId)).rejects.toThrow("could not be read authoritatively");
  const frozen = await database.db.select().from(governanceCheckpoints).where(eq(governanceCheckpoints.runId, fixture.runId));
  expect(frozen).toHaveLength(0);
});
