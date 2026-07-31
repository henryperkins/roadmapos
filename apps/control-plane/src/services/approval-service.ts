import { and, eq, isNull } from "drizzle-orm";
import {
  appendAuditEvent,
  approvalCarryovers,
  approvalInvalidations,
  approvals,
  enqueueJob,
  executionPlans,
  ExecutionRepository,
  repositories,
  repositoryPolicyVersions,
  runs,
  type Database
} from "@roadmapos/db";
import type { Condition } from "@roadmapos/domain";
import type { RepositoryPermission } from "@roadmapos/domain";
import type { GitHubGateway } from "@roadmapos/github";
import type { RepositoryPolicy } from "@roadmapos/policy";

const permissionRank: Record<RepositoryPermission, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5
};

export function meetsPermission(actual: RepositoryPermission, required: "write" | "maintain" | "admin"): boolean {
  return permissionRank[actual] >= permissionRank[required];
}

export interface RequestEligibility {
  distinctEligibleApprovers: number;
  invalidatedLogins: string[];
}

export class ApprovalService {
  constructor(
    private readonly database: Database,
    private readonly github: GitHubGateway,
    private readonly execution = new ExecutionRepository(database)
  ) {}

  async approvePlan(input: { runId: string; version: number; hashPrefix: string; githubUserId: string; githubLogin: string; githubCommentId: string }) {
    const [record] = await this.database.db
      .select({ run: runs, plan: executionPlans, repository: repositories, policy: repositoryPolicyVersions })
      .from(runs)
      .innerJoin(executionPlans, and(eq(executionPlans.runId, runs.id), eq(executionPlans.version, input.version)))
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .where(eq(runs.id, input.runId));
    if (!record) throw new Error("Plan version not found");
    if (record.run.currentPlanId !== record.plan.id) throw new Error("Plan version is superseded");
    if (!record.plan.contentHash.startsWith(input.hashPrefix)) throw new Error("Plan hash prefix does not match");

    const policy = record.policy.policyJson as RepositoryPolicy;
    const permission = await this.github.getRepositoryPermission({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, login: input.githubLogin });
    if (!meetsPermission(permission, policy.authorization.minimumApprovalRole)) {
      throw new Error(`Plan approval requires ${policy.authorization.minimumApprovalRole} permission`);
    }
    const branchHead = await this.github.getBranchHead({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, branch: record.repository.defaultBranch });
    if (branchHead !== record.plan.baseSha) throw new Error("Base branch changed; regenerate the plan before approval");

    const approvalId = crypto.randomUUID();
    await this.database.db.insert(approvals).values({
      id: approvalId,
      runId: input.runId,
      requestType: "execution_plan",
      requestId: record.plan.id,
      requestVersion: record.plan.version,
      requestHash: record.plan.contentHash,
      githubUserId: BigInt(input.githubUserId),
      githubLogin: input.githubLogin,
      repositoryPermission: permission,
      policyVersionId: record.policy.id,
      baseSha: record.plan.baseSha,
      githubCommentId: BigInt(input.githubCommentId)
    });
    await appendAuditEvent(this.database, { pilotId: record.run.pilotId, eventType: "plan.approved", actorType: "maintainer", actorId: input.githubUserId, payload: { runId: input.runId, planId: record.plan.id, version: record.plan.version, contentHash: record.plan.contentHash, permission } });

    const eligibility = await this.revalidateRequestApprovals({
      pilotId: record.run.pilotId,
      runId: input.runId,
      requestType: "execution_plan",
      requestId: record.plan.id,
      installationId: record.repository.installationId.toString(),
      owner: record.repository.owner,
      repo: record.repository.name,
      requiredRole: policy.authorization.minimumApprovalRole
    });
    const quorumReached = eligibility.distinctEligibleApprovers >= policy.authorization.executionPlanQuorum;
    if (quorumReached && record.run.state === "awaiting_plan_approval") {
      await this.restoreAfterPlanQuorum({
        runId: input.runId,
        pilotId: record.run.pilotId,
        currentPlanHash: record.plan.contentHash,
        installationId: record.repository.installationId.toString(),
        owner: record.repository.owner,
        repo: record.repository.name,
        policy
      });
    }
    return {
      approvalId,
      permission,
      activeApprovals: eligibility.distinctEligibleApprovers,
      invalidatedApprovals: eligibility.invalidatedLogins,
      requiredApprovals: policy.authorization.executionPlanQuorum,
      quorumReached
    };
  }

  private async restoreAfterPlanQuorum(input: {
    runId: string;
    pilotId: string;
    currentPlanHash: string;
    installationId: string;
    owner: string;
    repo: string;
    policy: RepositoryPolicy;
  }): Promise<void> {
    const [pending] = await this.database.sql<{
      checkpoint_id: string;
      proposal_id: string;
      operator_decision: "continue" | "pause_and_escalate";
      escalation_id: string | null;
      escalation_status: "awaiting_approval" | "approved" | null;
    }[]>`
      SELECT c.id AS checkpoint_id,
             c.action_proposal_id AS proposal_id,
             g.operator_decision,
             e.id AS escalation_id,
             e.status AS escalation_status
      FROM governance_checkpoints c
      JOIN live_gate_decisions g ON g.checkpoint_id = c.id
      JOIN action_proposals p ON p.id = c.action_proposal_id
      LEFT JOIN LATERAL (
        SELECT id, status
        FROM escalations
        WHERE checkpoint_id = c.id
        ORDER BY version DESC
        LIMIT 1
      ) e ON true
      WHERE c.run_id = ${input.runId}::uuid
        AND g.operator_decision IN ('continue', 'pause_and_escalate')
        AND p.status IN ('proposed', 'authorized')
        AND c.package_json #>> '{authorization,contentHash}' = ${input.currentPlanHash}
      ORDER BY c.created_at DESC
      LIMIT 1
    `;
    if (!pending) {
      await this.execution.transition({
        runId: input.runId, pilotId: input.pilotId, condition: "governed_orchestration",
        event: { type: "plan_quorum_reached" }, actorType: "system", actorId: "approval-service"
      });
      return;
    }

    let actionAuthorizationValid = pending.operator_decision === "continue";
    if (pending.operator_decision === "pause_and_escalate" && pending.escalation_id) {
      const escalationEligibility = await this.revalidateRequestApprovals({
        pilotId: input.pilotId,
        runId: input.runId,
        requestType: "escalation",
        requestId: pending.escalation_id,
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        requiredRole: input.policy.authorization.minimumApprovalRole
      });
      actionAuthorizationValid = pending.escalation_status === "approved"
        && escalationEligibility.distinctEligibleApprovers >= input.policy.authorization.escalationQuorum;
    }

    if (!actionAuthorizationValid) {
      await this.database.sql.begin(async (transaction) => {
        if (pending.escalation_id) {
          await transaction`
            UPDATE escalations SET status = 'awaiting_approval'
            WHERE id = ${pending.escalation_id}::uuid AND status = 'approved'
          `;
        }
        await transaction`
          UPDATE action_proposals SET status = 'proposed'
          WHERE id = ${pending.proposal_id}::uuid AND status = 'authorized'
        `;
        await this.execution.transitionTx(transaction, {
          runId: input.runId, pilotId: input.pilotId, condition: "governed_orchestration",
          event: { type: "plan_quorum_restored_pending_escalation" }, actorType: "system", actorId: "approval-service"
        });
      });
      return;
    }

    await this.database.sql.begin(async (transaction) => {
      await transaction`
        UPDATE action_proposals SET status = 'authorized'
        WHERE id = ${pending.proposal_id}::uuid AND status = 'proposed'
      `;
      await this.execution.transitionTx(transaction, {
        runId: input.runId, pilotId: input.pilotId, condition: "governed_orchestration",
        event: { type: "plan_quorum_restored_authorized_action" }, actorType: "system", actorId: "approval-service"
      });
    });
    await enqueueJob(this.database, "run.execute_action", { runId: input.runId, proposalId: pending.proposal_id });
  }

  async revalidateRequestApprovals(input: {
    pilotId: string;
    runId: string;
    requestType: "execution_plan" | "escalation";
    requestId: string;
    installationId: string;
    owner: string;
    repo: string;
    requiredRole: "write" | "maintain" | "admin";
  }): Promise<RequestEligibility> {
    const active = await this.database.db.select({ id: approvals.id, login: approvals.githubLogin, githubUserId: approvals.githubUserId })
      .from(approvals)
      .leftJoin(approvalInvalidations, eq(approvalInvalidations.approvalId, approvals.id))
      .where(and(eq(approvals.requestType, input.requestType), eq(approvals.requestId, input.requestId), isNull(approvalInvalidations.id)));

    const invalidatedLogins: string[] = [];
    for (const approval of active) {
      const current = await this.github.getRepositoryPermission({ installationId: input.installationId, owner: input.owner, repo: input.repo, login: approval.login });
      if (meetsPermission(current, input.requiredRole)) continue;
      const event = await appendAuditEvent(this.database, {
        pilotId: input.pilotId,
        eventType: "approval.permission_lost",
        actorType: "system",
        actorId: "approval-service",
        payload: { runId: input.runId, approvalId: approval.id, githubLogin: approval.login, requiredRole: input.requiredRole, currentPermission: current }
      });
      await this.database.db.insert(approvalInvalidations).values({
        id: crypto.randomUUID(),
        approvalId: approval.id,
        reason: `Repository permission fell below ${input.requiredRole}`,
        invalidatedByEventId: event.id
      });
      invalidatedLogins.push(approval.login);
    }

    const remaining = await this.database.db.select({ login: approvals.githubLogin }).from(approvals)
      .leftJoin(approvalInvalidations, eq(approvalInvalidations.approvalId, approvals.id))
      .where(and(eq(approvals.requestType, input.requestType), eq(approvals.requestId, input.requestId), isNull(approvalInvalidations.id)));
    return { distinctEligibleApprovers: new Set(remaining.map((approval) => approval.login)).size, invalidatedLogins };
  }

  /**
   * Counts the approvals that still authorize a plan: those recorded directly against it plus those
   * an operator carried over from the plan it editorially superseded.
   */
  async revalidatePlanApprovals(input: {
    pilotId: string;
    runId: string;
    planId: string;
    installationId: string;
    owner: string;
    repo: string;
    requiredRole: "write" | "maintain" | "admin";
  }): Promise<RequestEligibility> {
    const direct = await this.database.db.select({ id: approvals.id, login: approvals.githubLogin })
      .from(approvals)
      .leftJoin(approvalInvalidations, eq(approvalInvalidations.approvalId, approvals.id))
      .where(and(eq(approvals.requestType, "execution_plan"), eq(approvals.requestId, input.planId), isNull(approvalInvalidations.id)));
    const carried = await this.database.db.select({ id: approvals.id, login: approvals.githubLogin })
      .from(approvalCarryovers)
      .innerJoin(approvals, eq(approvals.id, approvalCarryovers.approvalId))
      .leftJoin(approvalInvalidations, eq(approvalInvalidations.approvalId, approvals.id))
      .where(and(eq(approvalCarryovers.toPlanId, input.planId), isNull(approvalInvalidations.id)));
    const active = [...new Map([...direct, ...carried].map((approval) => [approval.id, approval])).values()];
    const invalidatedLogins: string[] = [];
    for (const approval of active) {
      const current = await this.github.getRepositoryPermission({ installationId: input.installationId, owner: input.owner, repo: input.repo, login: approval.login });
      if (meetsPermission(current, input.requiredRole)) continue;
      const event = await appendAuditEvent(this.database, {
        pilotId: input.pilotId, eventType: "approval.permission_lost", actorType: "system", actorId: "approval-service",
        payload: { runId: input.runId, approvalId: approval.id, githubLogin: approval.login, requiredRole: input.requiredRole, currentPermission: current }
      });
      await this.database.db.insert(approvalInvalidations).values({
        id: crypto.randomUUID(), approvalId: approval.id, reason: `Repository permission fell below ${input.requiredRole}`, invalidatedByEventId: event.id
      }).onConflictDoNothing();
      invalidatedLogins.push(approval.login);
    }
    const ineligible = new Set(invalidatedLogins);
    return {
      distinctEligibleApprovers: new Set(active.filter((approval) => !ineligible.has(approval.login)).map((approval) => approval.login)).size,
      invalidatedLogins
    };
  }

  /**
   * The last live permission check before a repository write. If plan or escalation quorum has been
   * lost since the approval was recorded, the frozen proposal is returned to `proposed` and the run
   * waits for a replacement approval rather than executing on stale authority.
   */
  async revalidateBeforeExecution(input: { runId: string; checkpointId?: string }): Promise<void> {
    const [record] = await this.database.db
      .select({ run: runs, repository: repositories, policy: repositoryPolicyVersions })
      .from(runs)
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .where(eq(runs.id, input.runId));
    if (!record) throw new Error("Run not found");
    const policy = record.policy.policyJson as RepositoryPolicy;
    if (record.run.condition === "governed_orchestration") {
      if (!record.run.currentPlanId) throw new Error("Governed run has no current plan");
      const plan = await this.revalidatePlanApprovals({
        pilotId: record.run.pilotId, runId: input.runId, planId: record.run.currentPlanId,
        installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name,
        requiredRole: policy.authorization.minimumApprovalRole
      });
      if (plan.distinctEligibleApprovers < policy.authorization.executionPlanQuorum) {
        await this.database.sql`
          UPDATE action_proposals SET status = 'proposed'
          WHERE run_id = ${input.runId}::uuid AND status = 'authorized'
        `;
        if (record.run.state !== "awaiting_plan_approval") {
          await this.execution.transition({ runId: input.runId, pilotId: record.run.pilotId, condition: "governed_orchestration", event: { type: "plan_quorum_lost" }, actorType: "system", actorId: "approval-service" });
        }
        throw new Error("Execution-plan approval quorum was lost; replacement approval is required");
      }
    }

    if (!input.checkpointId) return;
    const [approved] = await this.database.sql<{ escalation_id: string; proposal_id: string; status: string }[]>`
      SELECT e.id AS escalation_id, c.action_proposal_id AS proposal_id, e.status
      FROM escalations e
      JOIN governance_checkpoints c ON c.id = e.checkpoint_id
      WHERE e.checkpoint_id = ${input.checkpointId}::uuid
      ORDER BY e.version DESC
      LIMIT 1
    `;
    if (!approved || approved.status !== "approved") return;
    const escalation = await this.revalidateRequestApprovals({
      pilotId: record.run.pilotId, runId: input.runId, requestType: "escalation", requestId: approved.escalation_id,
      installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name,
      requiredRole: policy.authorization.minimumApprovalRole
    });
    if (escalation.distinctEligibleApprovers >= policy.authorization.escalationQuorum) return;

    await this.database.sql.begin(async (transaction) => {
      await transaction`UPDATE escalations SET status = 'awaiting_approval' WHERE id = ${approved.escalation_id}::uuid AND status = 'approved'`;
      await transaction`UPDATE action_proposals SET status = 'proposed' WHERE id = ${approved.proposal_id}::uuid AND status = 'authorized'`;
      await this.execution.transitionTx(transaction, {
        runId: input.runId, pilotId: record.run.pilotId, condition: record.run.condition as Condition,
        event: { type: "escalation_quorum_lost" }, actorType: "system", actorId: "approval-service"
      });
    });
    throw new Error("Escalation approval quorum was lost; replacement approval is required");
  }
}
