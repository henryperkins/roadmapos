import { eq } from "drizzle-orm";
import {
  actionProposals,
  approvalInvalidations,
  approvals,
  deviations,
  escalations,
  liveGateDecisions,
  runs,
  type Database
} from "@roadmapos/db";
import { DeterministicFakeAgentGateway } from "@roadmapos/agent";
import { FakeGitHubGateway, FakeWorkspaceRunner, seedExecutionFixture, type ExecutionFixture } from "@roadmapos/testkit";
import { sha256Canonical, type CheckpointPackage, type JudgmentClassification } from "@roadmapos/domain";
import { CheckpointService } from "../../src/services/checkpoint-service.js";
import { ActionCoordinator } from "../../src/services/action-coordinator.js";
import { ApprovalService } from "../../src/services/approval-service.js";
import { EscalationService } from "../../src/services/escalation-service.js";
import { WorkspaceService } from "../../src/services/workspace-service.js";

export const PLAN_APPROVER = "maintainer-plan";
export const ESCALATION_APPROVER = "maintainer-escalation";
export const REPLACEMENT_APPROVER = "maintainer-replacement";

const PATCH = "diff --git a/src/auth/session.ts b/src/auth/session.ts\n--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1 +1 @@\n-a\n+b\n";

export const PROTECTED_PATCH_ACTION = {
  kind: "apply_patch" as const,
  patch: PATCH,
  summary: "Harden session handling",
  affectedPaths: ["src/auth/session.ts"],
  discoveredFacts: ["The session module has no empty-input guard"],
  changesPublicInterface: false,
  changesDependencies: false,
  changesSecurityBehavior: false
};

export const PLAIN_PATCH_ACTION = {
  kind: "apply_patch" as const,
  patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
  summary: "Update A",
  affectedPaths: ["src/a.ts"],
  discoveredFacts: ["A needs updating"],
  changesPublicInterface: false,
  changesDependencies: false,
  changesSecurityBehavior: false
};

export const DRAFT_PR_ACTION = { kind: "open_draft_pr" as const, title: "Fix parser behavior", body: "ignored" };

/** Seeds an immutable plan and one live maintainer approval through the real approval service. */
async function seedApprovedPlan(database: Database, fixture: ExecutionFixture, github: FakeGitHubGateway): Promise<string> {
  const planId = crypto.randomUUID();
  const contentHash = sha256Canonical({ plan: "v1", runId: fixture.runId });
  await database.sql`
    INSERT INTO execution_plans (id, run_id, version, plan_json, content_hash, base_sha, change_classification)
    VALUES (${planId}::uuid, ${fixture.runId}::uuid, 1, ${JSON.stringify(fixture.planDraft)}::jsonb, ${contentHash}, ${fixture.baseSha}, 'initial')
  `;
  await database.sql`UPDATE runs SET current_plan_id = ${planId}::uuid WHERE id = ${fixture.runId}::uuid`;
  await new ApprovalService(database, github).approvePlan({
    runId: fixture.runId,
    version: 1,
    hashPrefix: contentHash.slice(0, 16),
    githubUserId: "41",
    githubLogin: PLAN_APPROVER,
    githubCommentId: "600"
  });
  return planId;
}

function protectedClassification(decision: "pause_and_escalate" | "stop", protectedPath: string): JudgmentClassification {
  return {
    boundary: "repository_protected",
    planRelationship: "material_scope_expansion",
    decision,
    affectedPolicyRules: [`protected_zone:${protectedPath}`],
    facts: ["The patch changes authentication behavior"],
    requiredDisclosureFields: ["affected protected zone"],
    reversible: true,
    confidence: 95
  };
}

export interface RevealedCheckpointFixture {
  checkpointId: string;
  runId: string;
  proposalId: string;
  baseSha: string;
  github: FakeGitHubGateway;
  fixture: ExecutionFixture;
}

export async function seedRevealedCheckpointFixture(
  database: Database,
  input: { operatorDecision: "continue" | "pause_and_escalate" | "stop"; protectedPath: string }
): Promise<RevealedCheckpointFixture> {
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
  const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
  await seedApprovedPlan(database, fixture, github);

  const protectedRun = input.operatorDecision !== "continue";
  const action = protectedRun ? PROTECTED_PATCH_ACTION : PLAIN_PATCH_ACTION;
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [action], fixture.classifier);
  const checkpoints = new CheckpointService(database, agent, Buffer.alloc(32, 11).toString("base64"));
  const runner = new FakeWorkspaceRunner();
  const approvalService = new ApprovalService(database, github);
  const coordinator = new ActionCoordinator(
    database, agent, checkpoints, runner, github, fixture.publicBaseUrl,
    new WorkspaceService(database, github, runner), approvalService
  );

  const proposal = await coordinator.propose(fixture.runId);
  const checkpointId = proposal.checkpointId;
  if (!checkpointId) throw new Error("Expected a frozen checkpoint");

  const classification: JudgmentClassification = input.operatorDecision === "continue"
    ? {
        boundary: "none", planRelationship: "materially_equivalent_variation", decision: "continue",
        affectedPolicyRules: [], facts: ["The behavior remains within approved intent"],
        requiredDisclosureFields: ["actual implementation variation"], reversible: true, confidence: 88
      }
    : protectedClassification(input.operatorDecision, input.protectedPath);

  await checkpoints.recordOperatorClassification({
    checkpointId,
    operatorId: "operator-1",
    rationale: "Maintainer authorization may not cover this action",
    classification
  });

  return { checkpointId, runId: fixture.runId, proposalId: proposal.proposalId, baseSha: fixture.baseSha, github, fixture };
}

export interface EscalationApprovalResult {
  liveGateDecision: "pause_and_escalate";
  escalationStatus: "approved" | "awaiting_approval";
  proposalStatus: "executed" | "proposed";
  runState: "proposing_action" | "awaiting_escalation_approval";
  invalidatedApprovalCount: number;
}

/**
 * Drives the full pause → escalate → approve → execute path through the real services and reads
 * back the original live gate row to prove the operator's pause was never rewritten.
 */
export async function runEscalationApprovalFixture(
  database: Database,
  input: { permissionAfterApproval: "maintain" | "read" }
): Promise<EscalationApprovalResult> {
  const seeded = await seedRevealedCheckpointFixture(database, { operatorDecision: "pause_and_escalate", protectedPath: "src/auth/**" });
  const { github, fixture, checkpointId, runId, proposalId } = seeded;

  const escalation = await new EscalationService(database, github).create(checkpointId);
  const approvalService = new ApprovalService(database, github);
  await approvalService.approveEscalation({
    runId,
    version: escalation.version,
    hashPrefix: escalation.contentHash.slice(0, 16),
    githubUserId: "42",
    githubLogin: ESCALATION_APPROVER,
    githubCommentId: "700"
  });

  // Only the escalation approver's permission changes; the plan approver stays eligible so the
  // escalation quorum, not the plan quorum, is the thing under test.
  github.setPermission(ESCALATION_APPROVER, input.permissionAfterApproval);

  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
  const checkpoints = new CheckpointService(database, agent, Buffer.alloc(32, 11).toString("base64"));
  const runner = new FakeWorkspaceRunner();
  const coordinator = new ActionCoordinator(
    database, agent, checkpoints, runner, github, fixture.publicBaseUrl,
    new WorkspaceService(database, github, runner), approvalService
  );
  try {
    await coordinator.executeAfterGate(runId, proposalId);
  } catch (error) {
    if (input.permissionAfterApproval === "maintain") throw error;
  }

  const [gate] = await database.db.select().from(liveGateDecisions).where(eq(liveGateDecisions.checkpointId, checkpointId));
  const [escalationRow] = await database.db.select().from(escalations).where(eq(escalations.id, escalation.id));
  const [proposalRow] = await database.db.select().from(actionProposals).where(eq(actionProposals.id, proposalId));
  const [runRow] = await database.db.select({ state: runs.state }).from(runs).where(eq(runs.id, runId));
  const invalidated = await database.db.select({ id: approvalInvalidations.id })
    .from(approvalInvalidations)
    .innerJoin(approvals, eq(approvals.id, approvalInvalidations.approvalId))
    .where(eq(approvals.runId, runId));

  return {
    liveGateDecision: gate?.operatorDecision as "pause_and_escalate",
    escalationStatus: escalationRow?.status as "approved" | "awaiting_approval",
    proposalStatus: proposalRow?.status as "executed" | "proposed",
    runState: runRow?.state as "proposing_action" | "awaiting_escalation_approval",
    invalidatedApprovalCount: invalidated.length
  };
}

export interface PlanQuorumRestorationResult {
  invalidatedPlanApprovalCount: number;
  replacementApprovalCount: number;
  originalProposalId: string;
  executedProposalId: string;
  proposalCount: number;
  finalRunState: string;
}

/**
 * The original approver loses permission at the final pre-execution recheck. A replacement approval
 * must reauthorize and execute the exact frozen proposal, not send the agent back for a new action.
 */
export async function runPlanQuorumRestorationFixture(
  database: Database,
  input: { gateDecision: "continue" | "pause_and_escalate" }
): Promise<PlanQuorumRestorationResult> {
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action", executionPlanQuorum: 1 });
  const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
  await seedApprovedPlan(database, fixture, github);

  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [PLAIN_PATCH_ACTION], fixture.classifier);
  const checkpoints = new CheckpointService(database, agent, Buffer.alloc(32, 12).toString("base64"));
  const runner = new FakeWorkspaceRunner();
  const approvalService = new ApprovalService(database, github);
  const coordinator = new ActionCoordinator(
    database, agent, checkpoints, runner, github, fixture.publicBaseUrl,
    new WorkspaceService(database, github, runner), approvalService
  );

  const proposal = await coordinator.propose(fixture.runId);
  const checkpointId = proposal.checkpointId;
  if (!checkpointId) throw new Error("Expected a frozen checkpoint");
  await checkpoints.recordOperatorClassification({
    checkpointId,
    operatorId: "operator-1",
    rationale: "Within the approved plan",
    classification: {
      boundary: "none", planRelationship: "within_plan", decision: input.gateDecision,
      affectedPolicyRules: [], facts: ["Within plan"], requiredDisclosureFields: [], reversible: true, confidence: 91
    }
  });

  github.setPermission(PLAN_APPROVER, "read");
  await expectRejection(() => coordinator.executeAfterGate(fixture.runId, proposal.proposalId));

  const invalidatedAfterLoss = await database.db.select({ id: approvalInvalidations.id })
    .from(approvalInvalidations)
    .innerJoin(approvals, eq(approvals.id, approvalInvalidations.approvalId))
    .where(eq(approvals.runId, fixture.runId));

  const [plan] = await database.sql<{ content_hash: string }[]>`
    SELECT content_hash FROM execution_plans WHERE run_id = ${fixture.runId}::uuid ORDER BY version DESC LIMIT 1
  `;
  const replacement = await approvalService.approvePlan({
    runId: fixture.runId,
    version: 1,
    hashPrefix: (plan?.content_hash ?? "").slice(0, 16),
    githubUserId: "43",
    githubLogin: REPLACEMENT_APPROVER,
    githubCommentId: "800"
  });

  await coordinator.executeAfterGate(fixture.runId, proposal.proposalId);

  // Excludes the fixture's pre-seeded baseline row, so the count answers the question that matters:
  // did restoration reuse the frozen proposal, or ask the agent for a new one?
  const proposalRows = (await database.db.select().from(actionProposals).where(eq(actionProposals.runId, fixture.runId)))
    .filter((row) => row.id !== fixture.proposalId);
  const executed = proposalRows.find((row) => row.status === "executed");
  const [runRow] = await database.db.select({ state: runs.state }).from(runs).where(eq(runs.id, fixture.runId));

  return {
    invalidatedPlanApprovalCount: invalidatedAfterLoss.length,
    replacementApprovalCount: replacement.activeApprovals,
    originalProposalId: proposal.proposalId,
    executedProposalId: executed?.id ?? "none",
    proposalCount: proposalRows.length,
    finalRunState: runRow?.state ?? "unknown"
  };
}

export interface PullRequestFixture { runId: string; baseSha: string; proposalId: string; github: FakeGitHubGateway }

export async function seedPullRequestFixture(
  database: Database,
  input: { deviationCount: number }
): Promise<PullRequestFixture> {
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "executing_action" });
  const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
  const planId = crypto.randomUUID();
  await database.sql`
    INSERT INTO execution_plans (id, run_id, version, plan_json, content_hash, base_sha, change_classification)
    VALUES (${planId}::uuid, ${fixture.runId}::uuid, 1, ${JSON.stringify(fixture.planDraft)}::jsonb, ${sha256Canonical(fixture.planDraft)}, ${fixture.baseSha}, 'initial')
  `;
  await database.sql`UPDATE runs SET current_plan_id = ${planId}::uuid WHERE id = ${fixture.runId}::uuid`;

  const proposalId = crypto.randomUUID();
  await database.db.insert(actionProposals).values({
    id: proposalId,
    runId: fixture.runId,
    sequence: 2,
    actionJson: DRAFT_PR_ACTION,
    actionHash: sha256Canonical(DRAFT_PR_ACTION),
    status: "executing"
  });

  for (let index = 0; index < input.deviationCount; index += 1) {
    const disclosure = {
      originalPlanExpectation: "src/parser.ts",
      actualImplementationVariation: "Also updated the shared sanitizer that both entry points call",
      continueWithoutEscalationReason: "The behavior remains within approved intent",
      additionalFiles: ["src/sanitizer.ts"],
      additionalDependencies: [],
      reversible: true,
      evidence: ["The shared sanitizer is the only common entry point"],
      confidence: 88
    };
    const checkpointId = crypto.randomUUID();
    await database.sql`
      INSERT INTO governance_checkpoints (id, run_id, source, package_json, package_hash)
      VALUES (${checkpointId}::uuid, ${fixture.runId}::uuid, 'challenge', ${JSON.stringify(fixture.checkpointInput.package)}::jsonb, ${sha256Canonical({ deviation: index })})
    `;
    await database.db.insert(deviations).values({
      id: crypto.randomUUID(),
      runId: fixture.runId,
      checkpointId,
      disclosureJson: disclosure,
      contentHash: sha256Canonical(disclosure)
    });
  }

  return { runId: fixture.runId, baseSha: fixture.baseSha, proposalId, github };
}

export function checkpointPackageFor(fixture: ExecutionFixture): CheckpointPackage {
  return fixture.checkpointInput.package;
}

async function expectRejection(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("Expected the operation to be rejected");
}
