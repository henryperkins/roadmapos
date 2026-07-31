import { eq } from "drizzle-orm";
import {
  appendAuditEvent,
  executionPlans,
  ExecutionRepository,
  repositories,
  repositoryPolicyVersions,
  runs,
  workItems,
  type Database
} from "@roadmapos/db";
import { sha256Canonical, type ExecutionPlanDraft, type PlanGenerationInput } from "@roadmapos/domain";
import type { AgentGateway } from "@roadmapos/agent";
import type { GitHubGateway } from "@roadmapos/github";

export class PlanService {
  constructor(
    private readonly database: Database,
    private readonly agent: AgentGateway,
    private readonly github: GitHubGateway,
    private readonly execution = new ExecutionRepository(database)
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
      pilotId: record.run.pilotId,
      condition: "governed_orchestration",
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
