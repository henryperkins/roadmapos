import { beforeEach, describe, expect, it } from "vitest";
import { actionProposals, createDatabase, governanceCheckpoints, runs } from "@roadmapos/db";
import { eq } from "drizzle-orm";
import { DeterministicFakeAgentGateway } from "@roadmapos/agent";
import { FakeGitHubGateway, FakeWorkspaceRunner, resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";
import { CheckpointService } from "../src/services/checkpoint-service.js";
import { ActionCoordinator } from "../src/services/action-coordinator.js";
import { ApprovalService } from "../src/services/approval-service.js";
import { WorkspaceService } from "../src/services/workspace-service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabase(url);

beforeEach(async () => resetTestDatabase(url));

const patchAction = {
  kind: "apply_patch" as const,
  patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
  summary: "Update A",
  affectedPaths: ["src/a.ts"],
  discoveredFacts: ["A needs updating"],
  changesPublicInterface: false,
  changesDependencies: false,
  changesSecurityBehavior: false
};

const readAction = { kind: "read_files" as const, paths: ["src/a.ts"], purpose: "Inspect implementation" };

async function currentPlanFor(runId: string, planId: string): Promise<void> {
  await database.sql`UPDATE runs SET current_plan_id = ${planId}::uuid WHERE id = ${runId}::uuid`;
}

const PLAN_HASH = "d".repeat(64);

async function seedPlan(runId: string): Promise<string> {
  const planId = crypto.randomUUID();
  await database.sql`
    INSERT INTO execution_plans (id, run_id, version, plan_json, content_hash, base_sha, change_classification)
    VALUES (${planId}::uuid, ${runId}::uuid, 1, ${JSON.stringify({ steps: ["patch"] })}::jsonb, ${PLAN_HASH}, ${"a".repeat(40)}, 'initial')
  `;
  await currentPlanFor(runId, planId);
  return planId;
}

/** Records a real maintainer approval through the service so the pre-execution guard can see it. */
async function approvePlan(runId: string, github: FakeGitHubGateway): Promise<void> {
  await new ApprovalService(database, github).approvePlan({
    runId,
    version: 1,
    hashPrefix: PLAN_HASH.slice(0, 16),
    githubUserId: "41",
    githubLogin: "maintainer-a",
    githubCommentId: "600"
  });
}

describe("condition parity", () => {
  it("governed freezes a consequential proposal immediately, while interactive waits for /do", async () => {
    const governed = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
    const interactive = await seedExecutionFixture(database, { condition: "interactive_copilot", runState: "proposing_action", issueNumberOffset: 20 });
    await seedPlan(governed.runId);
    const agent = new DeterministicFakeAgentGateway(governed.planDraft, [patchAction, patchAction], governed.classifier);
    const github = new FakeGitHubGateway({ permission: "maintain", branchHead: governed.baseSha });
    const checkpoint = new CheckpointService(database, agent, Buffer.alloc(32, 9).toString("base64"));
    const coordinator = new ActionCoordinator(database, agent, checkpoint, new FakeWorkspaceRunner(), github, governed.publicBaseUrl);

    const governedProposal = await coordinator.propose(governed.runId);
    expect(governedProposal.checkpointId).toBeDefined();

    const interactiveProposal = await coordinator.propose(interactive.runId);
    expect(interactiveProposal.checkpointId).toBeUndefined();
    expect(github.comments.at(-1)).toContain(`/roadmapos do ${interactiveProposal.proposalId}`);

    const authorized = await coordinator.authorizeInteractiveAction({ runId: interactive.runId, proposalId: interactiveProposal.proposalId, githubUserId: "42", githubLogin: "maintainer", githubCommentId: "88" });
    expect(authorized.checkpointId).toBeDefined();
  });

  it("routes both conditions through the same checkpoint service and publishes the operator link", async () => {
    const governed = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
    await seedPlan(governed.runId);
    const agent = new DeterministicFakeAgentGateway(governed.planDraft, [patchAction], governed.classifier);
    const github = new FakeGitHubGateway({ permission: "maintain", branchHead: governed.baseSha });
    const checkpoint = new CheckpointService(database, agent, Buffer.alloc(32, 9).toString("base64"));
    const coordinator = new ActionCoordinator(database, agent, checkpoint, new FakeWorkspaceRunner(), github, governed.publicBaseUrl);

    const proposal = await coordinator.propose(governed.runId);
    const [frozen] = await database.db.select().from(governanceCheckpoints).where(eq(governanceCheckpoints.runId, governed.runId));
    expect(frozen?.source).toBe("agent_detected");
    expect(frozen?.actionProposalId).toBe(proposal.proposalId);
    expect(github.checks.at(-1)?.detailsUrl).toBe(`${governed.publicBaseUrl}/operator/checkpoints/${String(proposal.checkpointId)}`);
    const [run] = await database.db.select({ state: runs.state }).from(runs).where(eq(runs.id, governed.runId));
    expect(run?.state).toBe("awaiting_operator_gate");
  });

  it("authorizes a nonconsequential read without freezing a checkpoint", async () => {
    const governed = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
    await seedPlan(governed.runId);
    const agent = new DeterministicFakeAgentGateway(governed.planDraft, [readAction], governed.classifier);
    const github = new FakeGitHubGateway({ permission: "maintain", branchHead: governed.baseSha });
    const checkpoint = new CheckpointService(database, agent, Buffer.alloc(32, 9).toString("base64"));
    const coordinator = new ActionCoordinator(database, agent, checkpoint, new FakeWorkspaceRunner(), github, governed.publicBaseUrl);

    const proposal = await coordinator.propose(governed.runId);
    expect(proposal.checkpointId).toBeUndefined();
    const frozen = await database.db.select().from(governanceCheckpoints).where(eq(governanceCheckpoints.runId, governed.runId));
    expect(frozen).toHaveLength(0);
    const [run] = await database.db.select({ state: runs.state }).from(runs).where(eq(runs.id, governed.runId));
    expect(run?.state).toBe("executing_action");
  });

  it("executes an authorized action only after the gate and returns the run to its condition's next state", async () => {
    for (const condition of ["governed_orchestration", "interactive_copilot"] as const) {
      await resetTestDatabase(url);
      const fixture = await seedExecutionFixture(database, { condition, runState: "proposing_action" });
      const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [patchAction], fixture.classifier);
      const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
      await seedPlan(fixture.runId);
      if (condition === "governed_orchestration") await approvePlan(fixture.runId, github);
      const checkpoint = new CheckpointService(database, agent, Buffer.alloc(32, 9).toString("base64"));
      const runner = new FakeWorkspaceRunner();
      const approvals = new ApprovalService(database, github);
      const coordinator = new ActionCoordinator(
        database, agent, checkpoint, runner, github, fixture.publicBaseUrl,
        new WorkspaceService(database, github, runner), approvals
      );

      const proposal = condition === "governed_orchestration"
        ? await coordinator.propose(fixture.runId)
        : await coordinator.authorizeInteractiveAction({
            runId: fixture.runId,
            proposalId: (await coordinator.propose(fixture.runId)).proposalId,
            githubUserId: "42",
            githubLogin: "maintainer",
            githubCommentId: "88"
          });
      const checkpointId = proposal.checkpointId;
      if (!checkpointId) throw new Error("Expected a frozen checkpoint");

      await checkpoint.recordOperatorClassification({
        checkpointId,
        operatorId: "operator-1",
        rationale: "Within the approved authorization",
        classification: {
          boundary: "none", planRelationship: "within_plan", decision: "continue",
          affectedPolicyRules: [], facts: ["Within plan"], requiredDisclosureFields: [], reversible: true, confidence: 92
        }
      });

      await coordinator.executeAfterGate(fixture.runId, proposal.proposalId);
      expect(runner.appliedPatches).toHaveLength(1);
      const [executed] = await database.db.select().from(actionProposals).where(eq(actionProposals.id, proposal.proposalId));
      expect(executed?.status).toBe("executed");
      const [run] = await database.db.select({ state: runs.state }).from(runs).where(eq(runs.id, fixture.runId));
      expect(run?.state).toBe(condition === "governed_orchestration" ? "proposing_action" : "awaiting_instruction");

      // A retry of the same job is a no-op rather than a second repository write.
      await coordinator.executeAfterGate(fixture.runId, proposal.proposalId);
      expect(runner.appliedPatches).toHaveLength(1);
    }
  });

  it("refuses to execute a consequential action the operator has not cleared", async () => {
    const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
    await seedPlan(fixture.runId);
    const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [patchAction], fixture.classifier);
    const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
    const checkpoint = new CheckpointService(database, agent, Buffer.alloc(32, 9).toString("base64"));
    const runner = new FakeWorkspaceRunner();
    const coordinator = new ActionCoordinator(
      database, agent, checkpoint, runner, github, fixture.publicBaseUrl,
      new WorkspaceService(database, github, runner), new ApprovalService(database, github)
    );

    const proposal = await coordinator.propose(fixture.runId);
    await expect(coordinator.executeAfterGate(fixture.runId, proposal.proposalId)).rejects.toThrow("Proposal status proposed is not executable");
    expect(runner.appliedPatches).toHaveLength(0);
  });
});
