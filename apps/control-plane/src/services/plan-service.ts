import { and, eq, isNull } from "drizzle-orm";
import {
  appendAuditEvent,
  approvalCarryovers,
  approvalInvalidations,
  approvals,
  executionPlans,
  ExecutionRepository,
  governanceCheckpoints,
  judgmentComparisons,
  repositories,
  repositoryPolicyVersions,
  runs,
  workItems,
  type Database
} from "@roadmapos/db";
import {
  CheckpointPackageSchema,
  sha256Canonical,
  type ExecutionPlanDraft,
  type JudgmentClassification,
  type PlanGenerationInput
} from "@roadmapos/domain";
import type { AgentGateway } from "@roadmapos/agent";
import type { GitHubGateway } from "@roadmapos/github";
import type { CheckpointService } from "./checkpoint-service.js";

export class PlanService {
  constructor(
    private readonly database: Database,
    private readonly agent: AgentGateway,
    private readonly github: GitHubGateway,
    private readonly execution = new ExecutionRepository(database),
    private readonly checkpoints?: CheckpointService
  ) {}

  async generateInitialPlan(runId: string) {
    const [record] = await this.database.db
      .select({ run: runs, item: workItems, repository: repositories, policy: repositoryPolicyVersions })
      .from(runs)
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .where(eq(runs.id, runId));
    if (!record) throw new Error("Run not found");
    if (record.run.condition !== "governed_orchestration") throw new Error("Plans are generated only for governed runs");
    if (record.run.currentPlanId) throw new Error("Initial plan already exists");

    const contextPaths = ["README.md", "CONTRIBUTING.md", record.repository.policyPath];
    const repositoryContext: Array<{ path: string; content: string }> = [];
    for (const path of contextPaths) {
      try {
        repositoryContext.push({
          path,
          content: await this.github.getFile({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, path, ref: record.run.baseSha })
        });
      } catch {
        // A missing optional context file is represented by its absence; no hidden replacement context is supplied.
      }
    }
    const input: PlanGenerationInput = {
      repositoryId: record.repository.id,
      issueNumber: record.item.githubIssueNumber,
      baseSha: record.run.baseSha,
      policyHash: record.policy.policyHash,
      roadmapItem: { title: record.item.title, body: "", acceptanceCriteria: record.item.acceptanceCriteria as string[] },
      repositoryContext
    };
    const generated = await this.agent.generatePlan(input);
    const id = crypto.randomUUID();
    const version = 1;
    const contentHash = sha256Canonical(generated.value);
    await this.database.db.transaction(async (transaction) => {
      await transaction.insert(executionPlans).values({ id, runId, version, planJson: generated.value, contentHash, baseSha: record.run.baseSha, changeClassification: "initial" });
      await transaction.update(runs).set({ currentPlanId: id, updatedAt: new Date() }).where(eq(runs.id, runId));
    });
    await this.execution.transition({
      runId,
      event: { type: "plan_published" },
      actorType: "agent",
      actorId: generated.providerTraceId ?? "agent"
    });
    await appendAuditEvent(this.database, { pilotId: record.run.pilotId, eventType: "plan.published", actorType: "agent", actorId: generated.providerTraceId ?? "agent", payload: { runId, planId: id, version, contentHash, requestHash: generated.requestHash, outputHash: generated.outputHash } });
    await this.github.publishIssueComment({
      installationId: record.repository.installationId.toString(),
      owner: record.repository.owner,
      repo: record.repository.name,
      issueNumber: record.item.githubIssueNumber,
      body: renderPlanComment(version, contentHash, generated.value)
    });
    return { id, version, contentHash, value: generated.value };
  }

  /**
   * Produces a candidate replacement plan and freezes a plan-revision checkpoint over it. The
   * candidate does not become current here: whether prior approvals carry over or are invalidated
   * is the operator's classification to make.
   */
  async revisePlan(runId: string, maintainerFeedback: string): Promise<{ planId: string; version: number; contentHash: string; checkpointId: string }> {
    if (!this.checkpoints) throw new Error("Plan revision requires a checkpoint service");
    const [record] = await this.database.db
      .select({ run: runs, current: executionPlans, item: workItems, repository: repositories, policy: repositoryPolicyVersions })
      .from(runs)
      .innerJoin(executionPlans, eq(executionPlans.id, runs.currentPlanId))
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .where(eq(runs.id, runId));
    if (!record) throw new Error("Run or current plan not found");
    if (record.run.condition !== "governed_orchestration") throw new Error("Only governed runs have execution plans");
    if (!maintainerFeedback.trim()) throw new Error("Revision feedback is required");

    const generated = await this.agent.generatePlan({
      repositoryId: record.repository.id,
      issueNumber: record.item.githubIssueNumber,
      baseSha: record.run.baseSha,
      policyHash: record.policy.policyHash,
      roadmapItem: {
        title: record.item.title,
        body: JSON.stringify({ previousPlan: record.current.planJson, maintainerFeedback }),
        acceptanceCriteria: record.item.acceptanceCriteria as string[]
      },
      repositoryContext: []
    });
    const planId = crypto.randomUUID();
    const version = record.current.version + 1;
    const contentHash = sha256Canonical(generated.value);
    const facts = diffExecutionPlans(record.current.planJson as ExecutionPlanDraft, generated.value);
    await this.database.db.insert(executionPlans).values({
      id: planId,
      runId,
      version,
      planJson: generated.value,
      contentHash,
      baseSha: record.run.baseSha,
      supersedesPlanId: record.current.id,
      changeClassification: "pending_operator_classification"
    });
    const checkpointPackage = CheckpointPackageSchema.parse({
      schemaVersion: 1,
      repository: { owner: record.repository.owner, name: record.repository.name, baseSha: record.run.baseSha },
      policyHash: record.policy.policyHash,
      authorization: { kind: "execution_plan", version: record.current.version, contentHash: record.current.contentHash },
      contemplatedAction: {
        kind: "plan_revision",
        summary: `Replace plan v${String(record.current.version)} with v${String(version)}`,
        affectedPaths: generated.value.anticipatedPaths,
        patchHash: contentHash
      },
      discoveredFacts: facts,
      validationState: { completedCommandIds: [], failingCommandIds: [] },
      reversible: true,
      createdAt: new Date().toISOString()
    });
    const checkpoint = await this.checkpoints.freeze({ runId, source: "plan_revision", package: checkpointPackage });
    return { planId, version, contentHash, checkpointId: checkpoint.id };
  }

  async applyRevisionDecision(checkpointId: string, operatorId: string): Promise<"editorial_carried" | "approval_required" | "stopped"> {
    const [record] = await this.database.db
      .select({ checkpoint: governanceCheckpoints, comparison: judgmentComparisons, run: runs, oldPlan: executionPlans })
      .from(governanceCheckpoints)
      .innerJoin(judgmentComparisons, eq(judgmentComparisons.checkpointId, governanceCheckpoints.id))
      .innerJoin(runs, eq(runs.id, governanceCheckpoints.runId))
      .innerJoin(executionPlans, eq(executionPlans.id, runs.currentPlanId))
      .where(eq(governanceCheckpoints.id, checkpointId));
    if (!record || record.checkpoint.source !== "plan_revision") throw new Error("Plan-revision checkpoint not found");
    const frozenPackage = CheckpointPackageSchema.parse(record.checkpoint.packageJson);
    const candidateHash = frozenPackage.contemplatedAction.patchHash;
    if (!candidateHash) throw new Error("Plan-revision checkpoint is missing its candidate-plan hash");
    const [candidate] = await this.database.db.select().from(executionPlans)
      .where(and(
        eq(executionPlans.runId, record.run.id),
        eq(executionPlans.supersedesPlanId, record.oldPlan.id),
        eq(executionPlans.contentHash, candidateHash)
      ));
    if (!candidate) throw new Error("The exact candidate plan committed by the checkpoint was not found");
    const operator = record.comparison.operatorPayload as JudgmentClassification;

    if (operator.decision === "stop") {
      await this.execution.transition({
        runId: record.run.id,
        event: { type: "operator_stop" }, actorType: "operator", actorId: operatorId
      });
      return "stopped";
    }

    const active = await this.database.db.select({ id: approvals.id })
      .from(approvals)
      .leftJoin(approvalInvalidations, eq(approvalInvalidations.approvalId, approvals.id))
      .where(and(eq(approvals.requestType, "execution_plan"), eq(approvals.requestId, record.oldPlan.id), isNull(approvalInvalidations.id)));

    if (operator.decision === "continue" && operator.planRelationship === "editorial_only") {
      await this.database.db.transaction(async (transaction) => {
        for (const approval of active) {
          await transaction.insert(approvalCarryovers).values({
            id: crypto.randomUUID(), approvalId: approval.id, fromPlanId: record.oldPlan.id, toPlanId: candidate.id,
            checkpointId, rationale: operator.facts.join(" ")
          });
        }
        await transaction.update(runs).set({ currentPlanId: candidate.id, updatedAt: new Date() }).where(eq(runs.id, record.run.id));
      });
      await this.execution.transition({
        runId: record.run.id,
        event: { type: "editorial_revision_accepted" }, actorType: "operator", actorId: operatorId
      });
      return "editorial_carried";
    }

    const invalidationEvent = await appendAuditEvent(this.database, {
      pilotId: record.run.pilotId, eventType: "plan.revision_invalidated_prior_approvals", actorType: "operator", actorId: operatorId,
      payload: { runId: record.run.id, fromPlanId: record.oldPlan.id, toPlanId: candidate.id, checkpointId, operatorDecision: operator.decision, planRelationship: operator.planRelationship }
    });
    await this.database.db.transaction(async (transaction) => {
      for (const approval of active) {
        await transaction.insert(approvalInvalidations).values({
          id: crypto.randomUUID(), approvalId: approval.id, reason: `Plan superseded by material revision ${String(candidate.version)}`, invalidatedByEventId: invalidationEvent.id
        }).onConflictDoNothing();
      }
      await transaction.update(runs).set({ currentPlanId: candidate.id, updatedAt: new Date() }).where(eq(runs.id, record.run.id));
    });
    await this.execution.transition({
      runId: record.run.id,
      event: { type: "material_revision_requires_approval" }, actorType: "operator", actorId: operatorId
    });
    return "approval_required";
  }
}

function diffExecutionPlans(previous: ExecutionPlanDraft, next: ExecutionPlanDraft): string[] {
  const fields: Array<keyof ExecutionPlanDraft> = [
    "problemInterpretation", "acceptanceCriteria", "expectedPublicBehavior", "implementationSteps",
    "anticipatedPaths", "dependencies", "protectedZoneExpectations", "verificationCommandIds", "risks", "rollback"
  ];
  return fields
    .filter((field) => sha256Canonical(previous[field]) !== sha256Canonical(next[field]))
    .map((field) => `${field} changed from ${sha256Canonical(previous[field])} to ${sha256Canonical(next[field])}`);
}

export function renderPlanComment(version: number, contentHash: string, plan: ExecutionPlanDraft): string {
  return [
    `## RoadmapOS execution plan v${String(version)}`,
    `**Immutable hash:** \`${contentHash}\``,
    "",
    `**Problem interpretation:** ${plan.problemInterpretation}`,
    "",
    "### Acceptance criteria",
    ...plan.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
    "",
    "### Implementation steps",
    ...plan.implementationSteps.map((step, index) => `${String(index + 1)}. ${step}`),
    "",
    `**Verification:** ${plan.verificationCommandIds.map((id) => `\`${id}\``).join(", ")}`,
    `**Rollback:** ${plan.rollback}`,
    "",
    `Approve this exact version with \`/roadmapos approve-plan ${String(version)} ${contentHash.slice(0, 16)}\`.`
  ].join("\n");
}
