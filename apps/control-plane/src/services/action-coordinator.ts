import { and, asc, desc, eq } from "drizzle-orm";
import {
  actionProposals,
  appendAuditEvent,
  enqueueJob,
  executionPlans,
  ExecutionRepository,
  explicitInstructions,
  repositories,
  repositoryPolicyVersions,
  runTranscriptEntries,
  runs,
  workItems,
  type Database
} from "@roadmapos/db";
import { sha256Canonical, sha256Text, type ActionContext, type ActionProposal, type CheckpointPackage, type Condition } from "@roadmapos/domain";
import type { AgentGateway } from "@roadmapos/agent";
import type { GitHubGateway } from "@roadmapos/github";
import { buildEffectivePolicy, evaluateAction, type RepositoryPolicy } from "@roadmapos/policy";
import type { WorkspaceRunner } from "@roadmapos/runner";
import type { CheckpointService } from "./checkpoint-service.js";
import type { WorkspaceService } from "./workspace-service.js";
import type { ApprovalService } from "./approval-service.js";

export interface ProposalOutcome {
  proposalId: string;
  checkpointId: string | undefined;
}

const MAX_ACTIONS_PER_RUN = 40;

export class ActionCoordinator {
  private readonly execution: ExecutionRepository;

  constructor(
    private readonly database: Database,
    private readonly agent: AgentGateway,
    private readonly checkpoints: CheckpointService,
    private readonly runner: WorkspaceRunner,
    private readonly github: GitHubGateway,
    private readonly publicBaseUrl: string,
    private readonly workspaceService?: WorkspaceService,
    private readonly authorizationGuard?: Pick<ApprovalService, "revalidateBeforeExecution">
  ) {
    this.execution = new ExecutionRepository(database);
  }

  async propose(runId: string): Promise<ProposalOutcome> {
    const record = await this.loadRun(runId);
    if (record.run.state !== "proposing_action") {
      throw new Error(`Cannot propose an action while run is ${record.run.state}`);
    }
    const sequenceRows = await this.database.db.select({ sequence: actionProposals.sequence }).from(actionProposals).where(eq(actionProposals.runId, runId)).orderBy(asc(actionProposals.sequence));
    if (sequenceRows.length >= MAX_ACTIONS_PER_RUN) throw new Error("Run exceeded the 40-action pilot limit");
    const transcriptRows = await this.database.db.select().from(runTranscriptEntries).where(eq(runTranscriptEntries.runId, runId)).orderBy(asc(runTranscriptEntries.sequence));
    const policy = record.policy.policyJson as RepositoryPolicy;
    const authorization = record.run.condition === "governed_orchestration"
      ? await this.currentPlanAuthorization(runId)
      : "The maintainer has authorized recommendation of one next action only.";
    const context: ActionContext = {
      runId,
      condition: record.run.condition as Condition,
      authorizationText: authorization,
      transcript: transcriptRows.map((row) => ({ role: row.role as ActionContext["transcript"][number]["role"], content: row.content })),
      readablePaths: policy.execution.readablePaths,
      validationCommandIds: policy.execution.validationCommands.map((command) => command.id)
    };
    const proposed = await this.agent.proposeNextAction(context);
    const proposalId = crypto.randomUUID();
    const sequence = sequenceRows.length + 1;
    const actionHash = sha256Canonical(proposed.value);
    await this.database.db.insert(actionProposals).values({ id: proposalId, runId, sequence, actionJson: proposed.value, actionHash, status: "proposed" });
    await appendAuditEvent(this.database, { pilotId: record.run.pilotId, eventType: "action.proposed", actorType: "agent", actorId: proposed.providerTraceId ?? "agent", payload: { runId, proposalId, sequence, actionHash, requestHash: proposed.requestHash } });

    if (record.run.condition === "interactive_copilot") {
      await this.github.publishIssueComment({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, issueNumber: record.issueNumber, body: this.renderInteractiveProposal(proposalId, proposed.value) });
      return { proposalId, checkpointId: undefined };
    }
    return this.routeAuthorizedProposal(record, proposalId, proposed.value);
  }

  async requestInteractiveProposal(input: { runId: string; githubUserId: string; githubLogin: string }): Promise<void> {
    const record = await this.loadRun(input.runId);
    if (record.run.condition !== "interactive_copilot") {
      throw new Error("Only interactive-copilot runs accept next-action instructions");
    }
    await this.execution.transition({
      runId: input.runId,
      event: { type: "instruction_received" },
      actorType: "maintainer",
      actorId: input.githubUserId
    });
    await enqueueJob(this.database, "run.propose_action", { runId: input.runId });
  }

  async authorizeInteractiveAction(input: { runId: string; proposalId: string; githubUserId: string; githubLogin: string; githubCommentId: string }): Promise<ProposalOutcome> {
    const record = await this.loadRun(input.runId);
    if (record.run.condition !== "interactive_copilot") throw new Error("Action authorization command is only valid for interactive copilot");
    const [proposal] = await this.database.db.select().from(actionProposals).where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.runId, input.runId)));
    if (!proposal || proposal.status !== "proposed") throw new Error("Action proposal is not available for authorization");
    const permission = await this.github.getRepositoryPermission({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, login: input.githubLogin });
    if (!(["write", "maintain", "admin"] as string[]).includes(permission)) throw new Error("Interactive action authorization requires write permission");
    const previous = await this.database.db.select({ version: explicitInstructions.version }).from(explicitInstructions).where(eq(explicitInstructions.runId, input.runId));
    const version = previous.length + 1;
    const instruction = { proposalId: input.proposalId, actionHash: proposal.actionHash, text: `Authorize exactly action proposal ${input.proposalId}` };
    const instructionId = crypto.randomUUID();
    const contentHash = sha256Canonical(instruction);
    await this.database.db.insert(explicitInstructions).values({ id: instructionId, runId: input.runId, version, instructionText: instruction.text, contentHash, githubUserId: BigInt(input.githubUserId), githubCommentId: BigInt(input.githubCommentId), repositoryPermission: permission });
    return this.routeAuthorizedProposal(record, proposal.id, proposal.actionJson as ActionProposal, { kind: "explicit_instruction", version, contentHash });
  }

  private async routeAuthorizedProposal(
    record: Awaited<ReturnType<ActionCoordinator["loadRun"]>>,
    proposalId: string,
    action: ActionProposal,
    explicitAuthorization?: { kind: "explicit_instruction"; version: number; contentHash: string }
  ): Promise<ProposalOutcome> {
    if (action.kind === "read_files") {
      await this.database.db.update(actionProposals).set({ status: "authorized" }).where(and(eq(actionProposals.id, proposalId), eq(actionProposals.status, "proposed")));
      await this.execution.transition({
        runId: record.run.id,
        event: { type: "nonconsequential_action_authorized" },
        actorType: "system",
        actorId: "action-coordinator"
      });
      await enqueueJob(this.database, "run.execute_action", { runId: record.run.id, proposalId });
      return { proposalId, checkpointId: undefined };
    }
    const policy = record.policy.policyJson as RepositoryPolicy;
    const protection = await this.github.getBranchProtection({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, branch: record.repository.defaultBranch });
    const effective = buildEffectivePolicy(policy, { branchProtectionEnabled: protection.enabled, requiredApprovals: protection.requiredApprovals });
    const evaluation = evaluateAction(effective, action);
    const authorization = explicitAuthorization ?? await this.currentPlanReference(record.run.id);
    const checkpointPackage: CheckpointPackage = {
      schemaVersion: 1,
      repository: { owner: record.repository.owner, name: record.repository.name, baseSha: record.run.baseSha },
      policyHash: effective.policyHash,
      authorization,
      policyEvaluation: evaluation,
      contemplatedAction: {
        kind: action.kind,
        summary: this.actionSummary(action),
        affectedPaths: action.kind === "apply_patch" ? action.affectedPaths : [],
        ...(action.kind === "apply_patch" ? { patchHash: sha256Text(action.patch) } : {}),
        ...(action.kind === "run_validation" ? { validationCommandId: action.commandId } : {})
      },
      discoveredFacts: action.kind === "apply_patch" ? [...action.discoveredFacts, ...evaluation.matchedRules] : evaluation.matchedRules,
      validationState: { completedCommandIds: [], failingCommandIds: [] },
      reversible: true,
      createdAt: new Date().toISOString()
    };
    const checkpoint = await this.checkpoints.freeze({ runId: record.run.id, source: "agent_detected", actionProposalId: proposalId, package: checkpointPackage });
    await this.github.publishCheck({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, headSha: record.run.baseSha, name: "RoadmapOS governance gate", status: "completed", conclusion: "action_required", title: "Independent operator classification required", summary: `Checkpoint ${checkpoint.id} is frozen.`, detailsUrl: `${this.publicBaseUrl}/operator/checkpoints/${checkpoint.id}` });
    return { proposalId, checkpointId: checkpoint.id };
  }

  async executeAfterGate(runId: string, proposalId: string): Promise<void> {
    const record = await this.loadRun(runId);
    const [proposal] = await this.database.db.select().from(actionProposals).where(and(eq(actionProposals.id, proposalId), eq(actionProposals.runId, runId)));
    if (!proposal) throw new Error("Proposal not found");
    if (proposal.status === "executed") return;
    if (proposal.status !== "authorized") throw new Error(`Proposal status ${proposal.status} is not executable`);
    const action = proposal.actionJson as ActionProposal;

    const [checkpoint] = action.kind === "read_files"
      ? []
      : await this.database.sql<{ id: string }[]>`SELECT id FROM governance_checkpoints WHERE action_proposal_id = ${proposalId}::uuid`;
    if (action.kind !== "read_files" && !checkpoint) throw new Error("Consequential proposal has no checkpoint");
    // The last safe point before a repository write: re-check approver eligibility live rather than
    // trusting the permission recorded when the approval was first accepted.
    if (!this.authorizationGuard) throw new Error("Authorization guard is required for execution");
    await this.authorizationGuard.revalidateBeforeExecution({ runId, ...(checkpoint ? { checkpointId: checkpoint.id } : {}) });
    if (checkpoint) {
      const authorization = await this.checkpoints.resolveExecutionAuthorization(checkpoint.id);
      if (!authorization.authorized) throw new Error(`Action is not authorized: ${authorization.source}`);
    }

    const [claimed] = await this.database.sql<{ id: string }[]>`
      UPDATE action_proposals
      SET status = 'executing'
      WHERE id = ${proposalId}::uuid AND run_id = ${runId}::uuid AND status = 'authorized'
      RETURNING id
    `;
    if (!claimed) return;

    if (action.kind === "open_draft_pr") {
      await enqueueJob(this.database, "run.finalize_pr", { runId, proposalId, title: action.title });
      return;
    }
    if (action.kind === "finish") {
      await this.database.db.update(actionProposals).set({ status: "rejected" }).where(eq(actionProposals.id, proposalId));
      throw new Error("A finish action is invalid until a durable draft pull request exists");
    }

    if (!this.workspaceService) throw new Error("Workspace service is required for execution");
    const { handle, token } = await this.workspaceService.get(runId);
    let resultText: string;
    if (action.kind === "read_files") resultText = JSON.stringify(await this.runner.readFiles(handle, action.paths));
    else if (action.kind === "apply_patch") resultText = JSON.stringify(await this.runner.applyPatch(handle, action.patch));
    else if (action.kind === "run_validation") resultText = JSON.stringify(await this.runner.runValidation(handle, action.commandId));
    else resultText = JSON.stringify(await this.runner.commitAndPush(handle, action.message, token));

    // Ordered descending: the transcript sequence continues from the highest recorded entry.
    const [last] = await this.database.db.select({ sequence: runTranscriptEntries.sequence }).from(runTranscriptEntries).where(eq(runTranscriptEntries.runId, runId)).orderBy(desc(runTranscriptEntries.sequence)).limit(1);
    await this.database.db.insert(runTranscriptEntries).values({ id: crypto.randomUUID(), runId, sequence: (last?.sequence ?? 0) + 1, role: "tool", content: resultText, contentHash: sha256Text(resultText) });
    await this.database.db.update(actionProposals).set({ status: "executed", executedAt: new Date() }).where(eq(actionProposals.id, proposalId));
    await this.execution.transition({
      runId,
      event: { type: "action_completed" },
      actorType: "system",
      actorId: "action-coordinator"
    });
    if (record.run.condition === "governed_orchestration") await enqueueJob(this.database, "run.propose_action", { runId });
  }

  private async loadRun(runId: string) {
    const [record] = await this.database.db.select({
      run: runs,
      repository: repositories,
      policy: repositoryPolicyVersions,
      issueNumber: workItems.githubIssueNumber
    })
      .from(runs)
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .where(eq(runs.id, runId));
    if (!record) throw new Error("Run not found");
    return record;
  }

  private async currentPlanReference(runId: string): Promise<{ kind: "execution_plan"; version: number; contentHash: string }> {
    const [plan] = await this.database.db.select({ version: executionPlans.version, contentHash: executionPlans.contentHash })
      .from(executionPlans)
      .innerJoin(runs, eq(runs.currentPlanId, executionPlans.id))
      .where(eq(runs.id, runId));
    if (!plan) throw new Error("Governed run has no current plan");
    return { kind: "execution_plan", version: plan.version, contentHash: plan.contentHash };
  }

  private async currentPlanAuthorization(runId: string): Promise<string> {
    const [plan] = await this.database.db.select({ version: executionPlans.version, contentHash: executionPlans.contentHash, planJson: executionPlans.planJson })
      .from(executionPlans)
      .innerJoin(runs, eq(runs.currentPlanId, executionPlans.id))
      .where(eq(runs.id, runId));
    if (!plan) throw new Error("Governed run has no approved plan");
    return JSON.stringify({ version: plan.version, contentHash: plan.contentHash, plan: plan.planJson });
  }

  private actionSummary(action: ActionProposal): string {
    switch (action.kind) {
      case "read_files": return `Read ${action.paths.join(", ")}: ${action.purpose}`;
      case "apply_patch": return action.summary;
      case "run_validation": return `Run validation ${action.commandId}: ${action.reason}`;
      case "commit_and_push": return action.summary;
      case "open_draft_pr": return `Open draft PR: ${action.title}`;
      case "finish": return action.summary;
    }
  }

  private actionDetail(action: ActionProposal): string {
    if (action.kind === "read_files") return `Paths: ${action.paths.join(", ")}`;
    if (action.kind === "apply_patch") return `Affected paths: ${action.affectedPaths.join(", ")}`;
    if (action.kind === "run_validation") return `Validation command ID: ${action.commandId}`;
    if (action.kind === "commit_and_push") return `Commit message: ${action.message}`;
    if (action.kind === "open_draft_pr") return `Draft title: ${action.title}`;
    return `Known limitations: ${action.knownLimitations.join("; ") || "none stated"}`;
  }

  private renderInteractiveProposal(proposalId: string, action: ActionProposal): string {
    return [
      "## RoadmapOS proposed next action",
      "",
      `**Kind:** ${action.kind}`,
      `**Summary:** ${this.actionSummary(action)}`,
      `**Details:** ${this.actionDetail(action)}`,
      `**Action hash:** \`${sha256Canonical(action)}\``,
      "",
      "This proposal is not authorized yet. To authorize exactly this action, an eligible maintainer must comment:",
      "",
      `\`/roadmapos do ${proposalId}\``
    ].join("\n");
  }
}
