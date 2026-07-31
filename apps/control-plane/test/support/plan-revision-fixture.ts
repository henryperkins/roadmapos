import { and, eq } from "drizzle-orm";
import {
  approvalCarryovers,
  createDatabase,
  ExecutionRepository,
  executionPlans,
  runs
} from "@roadmapos/db";
import { DeterministicFakeAgentGateway } from "@roadmapos/agent";
import { FakeGitHubGateway, resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";
import { sha256Canonical } from "@roadmapos/domain";
import { CheckpointService } from "../../src/services/checkpoint-service.js";
import { PlanService } from "../../src/services/plan-service.js";
import { ApprovalService } from "../../src/services/approval-service.js";

const rawUrl = process.env.TEST_DATABASE_URL;
if (!rawUrl) throw new Error("TEST_DATABASE_URL is required");
const url: string = rawUrl;

export interface RevisionFixtureResult {
  activeApprovalCountForNewPlan: number;
  carriedApprovalCount: number;
  runState: string;
}

/**
 * Performs a plan revision entirely through CheckpointService, PlanService and ApprovalService.
 * Nothing here writes an approval or a run state directly: whether the prior approval carries over
 * is decided by the operator's classification, exactly as it is in production.
 */
export async function runRevisionFixture(input: {
  operatorRelationship: "editorial_only" | "material_scope_expansion";
}): Promise<RevisionFixtureResult> {
  await resetTestDatabase(url);
  const database = createDatabase(url);
  try {
    const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action", executionPlanQuorum: 1 });
    const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });

    // v1 differs from the fake agent's plan so the revision produces a genuinely new content hash.
    const originalPlan = { ...fixture.planDraft, problemInterpretation: "The original, superseded interpretation" };
    const originalPlanId = crypto.randomUUID();
    const originalHash = sha256Canonical(originalPlan);
    await database.sql`
      INSERT INTO execution_plans (id, run_id, version, plan_json, content_hash, base_sha, change_classification)
      VALUES (${originalPlanId}::uuid, ${fixture.runId}::uuid, 1, ${JSON.stringify(originalPlan)}::jsonb, ${originalHash}, ${fixture.baseSha}, 'initial')
    `;
    await database.sql`UPDATE runs SET current_plan_id = ${originalPlanId}::uuid WHERE id = ${fixture.runId}::uuid`;

    const approvals = new ApprovalService(database, github);
    await approvals.approvePlan({
      runId: fixture.runId,
      version: 1,
      hashPrefix: originalHash.slice(0, 16),
      githubUserId: "41",
      githubLogin: "maintainer-a",
      githubCommentId: "900"
    });

    const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], () => ({
      boundary: "none",
      planRelationship: input.operatorRelationship,
      decision: "continue",
      affectedPolicyRules: [],
      facts: ["The revision restates the same delivery intent"],
      requiredDisclosureFields: [],
      reversible: true,
      confidence: 90
    }));
    const checkpoints = new CheckpointService(database, agent, Buffer.alloc(32, 13).toString("base64"));
    const plans = new PlanService(database, agent, github, new ExecutionRepository(database), checkpoints);

    const revision = await plans.revisePlan(fixture.runId, "Narrow the scope to the parser entry point");
    await checkpoints.recordOperatorClassification({
      checkpointId: revision.checkpointId,
      operatorId: "operator-1",
      rationale: "Independent classification of the revision",
      classification: {
        boundary: "none",
        planRelationship: input.operatorRelationship,
        decision: "continue",
        affectedPolicyRules: [],
        facts: ["The revision restates the same delivery intent"],
        requiredDisclosureFields: [],
        reversible: true,
        confidence: 90
      }
    });
    await plans.applyRevisionDecision(revision.checkpointId, "operator-1");

    const [candidate] = await database.db.select().from(executionPlans)
      .where(and(eq(executionPlans.runId, fixture.runId), eq(executionPlans.version, revision.version)));
    if (!candidate) throw new Error("Candidate plan not found");

    const eligibility = await approvals.revalidatePlanApprovals({
      pilotId: fixture.pilotId,
      runId: fixture.runId,
      planId: candidate.id,
      installationId: "1",
      owner: "acme",
      repo: "widget",
      requiredRole: "maintain"
    });
    const carried = await database.db.select({ id: approvalCarryovers.id }).from(approvalCarryovers).where(eq(approvalCarryovers.toPlanId, candidate.id));
    const [run] = await database.db.select({ state: runs.state, currentPlanId: runs.currentPlanId }).from(runs).where(eq(runs.id, fixture.runId));
    if (run?.currentPlanId !== candidate.id) throw new Error("The candidate plan did not become current");

    return {
      activeApprovalCountForNewPlan: eligibility.distinctEligibleApprovers,
      carriedApprovalCount: carried.length,
      runState: run.state
    };
  } finally {
    await database.close();
  }
}
