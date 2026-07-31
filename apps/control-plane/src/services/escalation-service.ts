import { eq } from "drizzle-orm";
import {
  actionProposals,
  insertEscalation,
  executionPlans,
  governanceCheckpoints,
  judgmentComparisons,
  repositories,
  runs,
  workItems,
  type Database
} from "@roadmapos/db";
import { EscalationRequestSchema, sha256Canonical, type ActionProposal, type EscalationRequest, type JudgmentClassification } from "@roadmapos/domain";
import type { GitHubGateway } from "@roadmapos/github";

export class EscalationService {
  constructor(private readonly database: Database, private readonly github: GitHubGateway) {}

  async create(checkpointId: string) {
    const [record] = await this.database.db
      .select({ checkpoint: governanceCheckpoints, comparison: judgmentComparisons, run: runs, proposal: actionProposals, repository: repositories, item: workItems, plan: executionPlans })
      .from(governanceCheckpoints)
      .innerJoin(judgmentComparisons, eq(judgmentComparisons.checkpointId, governanceCheckpoints.id))
      .innerJoin(runs, eq(runs.id, governanceCheckpoints.runId))
      .innerJoin(actionProposals, eq(actionProposals.id, governanceCheckpoints.actionProposalId))
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .leftJoin(executionPlans, eq(executionPlans.id, runs.currentPlanId))
      .where(eq(governanceCheckpoints.id, checkpointId));
    if (!record) throw new Error("Checkpoint not found");
    const operator = record.comparison.operatorPayload as JudgmentClassification;
    if (operator.decision !== "pause_and_escalate") throw new Error("Escalation requires an operator pause decision");
    const action = record.proposal.actionJson as ActionProposal;
    const payload = EscalationRequestSchema.parse({
      approvedPlanVersion: record.plan?.version ?? null,
      discovered: operator.facts,
      differenceFromAuthorization: operator.planRelationship,
      necessity: actionSummaryForEscalation(action),
      affectedPaths: action.kind === "apply_patch" ? action.affectedPaths : [],
      affectedDependencies: action.kind === "apply_patch" && action.changesDependencies ? ["Agent-declared dependency change"] : [],
      affectedInterfaces: action.kind === "apply_patch" && action.changesPublicInterface ? ["Agent-declared public interface change"] : [],
      protectedZones: operator.affectedPolicyRules.filter((rule) => rule.startsWith("protected_zone:")),
      alternatives: [
        { label: "Approve this exact escalation", consequence: "The operator may execute the frozen action only." },
        { label: "Reject and request an alternative", consequence: "The action is rejected and the agent must propose a different bounded action." },
        { label: "Stop the run", consequence: "No further repository writes occur." }
      ],
      recommendation: `Pause for maintainer review before ${actionSummaryForEscalation(action)}.`,
      approvalConsequence: "The frozen action becomes eligible for operator-controlled execution.",
      rejectionConsequence: "The frozen action remains unexecuted and the run returns to planning or terminates.",
      reversible: operator.reversible,
      confidence: operator.confidence,
      evidence: operator.facts
    });
    const id = crypto.randomUUID();
    const contentHash = sha256Canonical(payload);
    const version = await insertEscalation(this.database.sql, {
      id, runId: record.run.id, checkpointId, escalation: payload, contentHash
    });
    await this.github.publishIssueComment({
      installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, issueNumber: record.item.githubIssueNumber,
      body: renderEscalation(version, contentHash, payload)
    });
    return { id, version, contentHash, payload };
  }
}

function actionSummaryForEscalation(action: ActionProposal): string {
  if (action.kind === "apply_patch") return action.summary;
  if (action.kind === "run_validation") return `run validation ${action.commandId}`;
  if (action.kind === "commit_and_push") return action.summary;
  if (action.kind === "open_draft_pr") return `open draft pull request ${action.title}`;
  if (action.kind === "read_files") return action.purpose;
  return action.summary;
}

function renderEscalation(version: number, hash: string, payload: EscalationRequest): string {
  return [
    `## RoadmapOS escalation v${String(version)}`,
    `**Immutable hash:** \`${hash}\``,
    `**Difference from authorization:** ${payload.differenceFromAuthorization}`,
    `**Why this arose:** ${payload.necessity}`,
    "### Evidence",
    ...payload.evidence.map((fact) => `- ${fact}`),
    "### Alternatives",
    ...payload.alternatives.map((alternative) => `- **${alternative.label}:** ${alternative.consequence}`),
    `**Recommendation:** ${payload.recommendation}`,
    "",
    `Approve with \`/roadmapos approve-escalation ${String(version)} ${hash.slice(0, 16)}\` or reject with \`/roadmapos reject-escalation ${String(version)}\`.`
  ].join("\n");
}
