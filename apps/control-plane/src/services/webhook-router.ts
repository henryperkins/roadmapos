import { and, desc, eq } from "drizzle-orm";
import { ExecutionRepository, repositories, repositoryPolicyVersions, runs, workItems, type Database } from "@roadmapos/db";
import type { RoadmapOsCommand } from "@roadmapos/github";
import type { Condition } from "@roadmapos/domain";
import type { GitHubWebhookDependencies, IssueCommentPayload, IssueLabeledPayload } from "../jobs/github-webhook-handler.js";
import type { RunBootstrapService } from "./run-bootstrap-service.js";
import type { ApprovalService } from "./approval-service.js";
import type { ActionCoordinator } from "./action-coordinator.js";
import type { PlanService } from "./plan-service.js";

export interface ResolvedRunContext {
  runId: string;
  pilotId: string;
  condition: Condition;
}

/**
 * Resolves GitHub identities to pilot records and dispatches maintainer commands. Nothing here
 * decides policy; it only maps a verified delivery onto the service that owns the decision.
 */
export class WebhookRouter implements GitHubWebhookDependencies {
  constructor(
    private readonly database: Database,
    private readonly bootstrap: RunBootstrapService,
    private readonly approvals: ApprovalService,
    private readonly coordinator: ActionCoordinator,
    private readonly plans: PlanService,
    private readonly execution = new ExecutionRepository(database)
  ) {}

  async startReadyIssue(payload: IssueLabeledPayload): Promise<void> {
    const [repository] = await this.database.db.select().from(repositories)
      .where(eq(repositories.githubRepositoryId, BigInt(payload.repository.id)));
    if (!repository) throw new Error(`Repository ${payload.repository.owner.login}/${payload.repository.name} is not registered in the pilot`);

    const [item] = await this.database.db.select().from(workItems)
      .where(and(eq(workItems.repositoryId, repository.id), eq(workItems.githubIssueNumber, payload.issue.number)));
    if (!item) throw new Error(`Issue #${String(payload.issue.number)} is not a registered work item`);
    if (!item.condition) throw new Error(`Work item for issue #${String(payload.issue.number)} has no assigned condition`);

    const [existing] = await this.database.db.select({ id: runs.id }).from(runs).where(eq(runs.workItemId, item.id));
    if (existing) return;

    const [policy] = await this.database.db.select().from(repositoryPolicyVersions)
      .where(eq(repositoryPolicyVersions.repositoryId, repository.id))
      .orderBy(desc(repositoryPolicyVersions.createdAt))
      .limit(1);
    if (!policy) throw new Error("Repository has no policy snapshot");

    await this.bootstrap.start({
      pilotId: repository.pilotId,
      workItemId: item.id,
      repositoryId: repository.id,
      policyVersionId: policy.id,
      condition: item.condition as Condition,
      installationId: repository.installationId.toString(),
      owner: repository.owner,
      repo: repository.name,
      defaultBranch: repository.defaultBranch
    });
  }

  async resolveRun(payload: IssueCommentPayload): Promise<ResolvedRunContext> {
    const [record] = await this.database.db.select({ run: runs })
      .from(runs)
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .where(and(
        eq(repositories.githubRepositoryId, BigInt(payload.repository.id)),
        eq(workItems.githubIssueNumber, payload.issue.number)
      ));
    if (!record) throw new Error(`No RoadmapOS run exists for issue #${String(payload.issue.number)}`);
    return { runId: record.run.id, pilotId: record.run.pilotId, condition: record.run.condition as Condition };
  }

  async routeCommand(payload: IssueCommentPayload, command: RoadmapOsCommand): Promise<void> {
    const { runId } = await this.resolveRun(payload);
    const actor = {
      githubUserId: String(payload.comment.user.id),
      githubLogin: payload.comment.user.login,
      githubCommentId: String(payload.comment.id)
    };
    switch (command.kind) {
      case "approve_plan":
        await this.approvals.approvePlan({ runId, version: command.version, hashPrefix: command.hashPrefix, ...actor });
        return;
      case "next_action":
        await this.coordinator.requestInteractiveProposal({ runId, githubUserId: actor.githubUserId, githubLogin: actor.githubLogin });
        return;
      case "authorize_action":
        await this.coordinator.authorizeInteractiveAction({ runId, proposalId: command.proposalId, ...actor });
        return;
      case "revise_plan":
        await this.plans.revisePlan(runId, command.feedback);
        return;
      case "approve_escalation":
        await this.approvals.approveEscalation({ runId, version: command.version, hashPrefix: command.hashPrefix, ...actor });
        return;
      case "reject_escalation":
        await this.approvals.rejectEscalation({ runId, version: command.version, githubUserId: actor.githubUserId, githubLogin: actor.githubLogin });
        return;
      case "review_ready":
        await this.declareReviewReady(runId, actor.githubUserId);
        return;
      case "terminate":
        await this.terminate(runId, command.reason, actor.githubUserId);
        return;
    }
  }

  private async declareReviewReady(runId: string, actorId: string): Promise<void> {
    const [run] = await this.database.db.select().from(runs).where(eq(runs.id, runId));
    if (!run) throw new Error("Run not found");
    await this.execution.transition({
      runId, pilotId: run.pilotId, condition: run.condition as Condition,
      event: { type: "review_ready_declared" }, actorType: "maintainer", actorId
    });
  }

  private async terminate(runId: string, reason: string, actorId: string): Promise<void> {
    const [run] = await this.database.db.select().from(runs).where(eq(runs.id, runId));
    if (!run) throw new Error("Run not found");
    await this.database.sql.begin(async (transaction) => {
      await this.execution.transitionTx(transaction, {
        runId, pilotId: run.pilotId, condition: run.condition as Condition,
        event: { type: "terminated" }, actorType: "maintainer", actorId
      });
      await transaction`UPDATE runs SET termination_reason = ${reason} WHERE id = ${runId}::uuid`;
    });
  }
}
