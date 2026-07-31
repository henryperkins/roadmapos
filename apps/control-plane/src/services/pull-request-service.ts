import { asc, eq } from "drizzle-orm";
import {
  actionProposals,
  deviations,
  draftPullRequests,
  escalations,
  executionPlans,
  ExecutionRepository,
  repositories,
  runs,
  runTranscriptEntries,
  workItems,
  type Database
} from "@roadmapos/db";
import { sha256Text, type DeviationDisclosure, type EscalationRequest, type ExecutionPlanDraft } from "@roadmapos/domain";
import type { GitHubGateway } from "@roadmapos/github";

type RunRow = typeof runs.$inferSelect;
type DeviationRow = typeof deviations.$inferSelect;
type EscalationRow = typeof escalations.$inferSelect;
type TranscriptRow = typeof runTranscriptEntries.$inferSelect;

interface PullRequestEvidence {
  run: RunRow;
  repository: typeof repositories.$inferSelect;
  item: typeof workItems.$inferSelect;
  plan: ExecutionPlanDraft | undefined;
  planVersion: number | null;
  planHash: string | null;
  policyHash: string;
  deviations: DeviationRow[];
  escalations: EscalationRow[];
  transcript: TranscriptRow[];
}

export class PullRequestService {
  constructor(
    private readonly database: Database,
    private readonly github: GitHubGateway,
    private readonly execution = new ExecutionRepository(database)
  ) {}

  async openDraft(runId: string, title: string, proposalId: string) {
    const [record] = await this.database.db.select({ run: runs, repository: repositories, item: workItems, plan: executionPlans })
      .from(runs)
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .leftJoin(executionPlans, eq(executionPlans.id, runs.currentPlanId))
      .where(eq(runs.id, runId));
    if (!record) throw new Error("Run not found");
    const [proposal] = await this.database.db.select().from(actionProposals).where(eq(actionProposals.id, proposalId));
    if (!proposal || proposal.runId !== runId || (proposal.actionJson as { kind?: string }).kind !== "open_draft_pr") {
      throw new Error("Draft PR finalization requires the exact open_draft_pr proposal");
    }
    const [existing] = await this.database.db.select().from(draftPullRequests).where(eq(draftPullRequests.runId, runId));
    if (existing) {
      await this.completeProjection(record.run, proposalId);
      return { number: existing.number, url: existing.htmlUrl };
    }

    const [policy] = await this.database.sql<{ policy_hash: string }[]>`
      SELECT policy_hash FROM repository_policy_versions WHERE id = ${record.run.policyVersionId}::uuid
    `;
    const deviationRows = await this.database.db.select().from(deviations).where(eq(deviations.runId, runId));
    const escalationRows = await this.database.db.select().from(escalations).where(eq(escalations.runId, runId));
    const transcript = await this.database.db.select().from(runTranscriptEntries).where(eq(runTranscriptEntries.runId, runId)).orderBy(asc(runTranscriptEntries.sequence));
    const body = renderPullRequestBody({
      run: record.run,
      repository: record.repository,
      item: record.item,
      plan: (record.plan?.planJson as ExecutionPlanDraft | undefined) ?? undefined,
      planVersion: record.plan?.version ?? null,
      planHash: record.plan?.contentHash ?? null,
      policyHash: policy?.policy_hash ?? "unknown",
      deviations: deviationRows,
      escalations: escalationRows,
      transcript
    });
    const created = await this.github.openDraftPullRequest({
      installationId: record.repository.installationId.toString(),
      owner: record.repository.owner,
      repo: record.repository.name,
      base: record.repository.defaultBranch,
      head: record.run.branchName,
      title,
      body
    });
    await this.database.db.insert(draftPullRequests).values({
      id: crypto.randomUUID(),
      runId,
      githubPullRequestId: BigInt(created.id),
      number: created.number,
      htmlUrl: created.url ?? "",
      headSha: await this.github.getBranchHead({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, branch: record.run.branchName }),
      bodyHash: sha256Text(body)
    }).onConflictDoNothing();
    await this.completeProjection(record.run, proposalId);
    return { number: created.number, url: created.url };
  }

  private async completeProjection(run: RunRow, proposalId: string): Promise<void> {
    await this.database.db.update(actionProposals).set({ status: "executed", executedAt: new Date() }).where(eq(actionProposals.id, proposalId));
    const [current] = await this.database.db.select({ state: runs.state }).from(runs).where(eq(runs.id, run.id));
    if (!current) throw new Error("Run not found while finalizing draft PR");
    if (current.state === "awaiting_review_ready") return;
    if (current.state !== "executing_action") throw new Error(`Cannot finalize draft PR while run is ${current.state}`);
    await this.execution.transition({
      runId: run.id,
      event: { type: "draft_pr_opened" },
      actorType: "system",
      actorId: "pull-request-service"
    });
  }
}

function bullets(values: string[], empty: string): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : [`- ${empty}`];
}

/**
 * The body is derived only from durable pilot records. It never contains an encrypted
 * classification, a model's private reasoning, or any credential.
 */
export function renderPullRequestBody(evidence: PullRequestEvidence): string {
  const validationLines = evidence.transcript
    .filter((entry) => entry.role === "tool" && entry.content.includes("commandId"))
    .map((entry) => `- \`${entry.contentHash.slice(0, 16)}\` ${entry.content.slice(0, 200)}`);
  const deviationLines = evidence.deviations.flatMap((row) => {
    const disclosure = row.disclosureJson as DeviationDisclosure;
    return [
      `- **Planned:** ${disclosure.originalPlanExpectation}`,
      `  **Actual:** ${disclosure.actualImplementationVariation}`,
      `  **Why it did not require escalation:** ${disclosure.continueWithoutEscalationReason}`,
      `  **Additional files:** ${disclosure.additionalFiles.join(", ") || "none"}`,
      `  **Reversible:** ${String(disclosure.reversible)}`
    ];
  });
  const escalationLines = evidence.escalations.flatMap((row) => {
    const request = row.escalationJson as EscalationRequest;
    return [
      `- **v${String(row.version)} (${row.status}):** ${request.differenceFromAuthorization} — ${request.recommendation}`,
      `  **Hash:** \`${row.contentHash}\``
    ];
  });

  return [
    "## Why",
    evidence.plan?.problemInterpretation ?? evidence.item.title,
    "",
    "## What changed",
    ...bullets(evidence.plan?.implementationSteps ?? [], "See the commit history on this branch"),
    "",
    "## Acceptance criteria and evidence",
    ...bullets(evidence.plan?.acceptanceCriteria ?? (evidence.item.acceptanceCriteria as string[]), "No acceptance criteria were recorded"),
    "",
    "## Tests and validation",
    ...bullets(validationLines.length > 0 ? validationLines.map((line) => line.slice(2)) : [], "No validation command was executed in this run"),
    "",
    "## Risk and rollback",
    ...bullets(evidence.plan?.risks ?? [], "No risk was recorded"),
    `**Rollback:** ${evidence.plan?.rollback ?? "Revert the commits on this branch"}`,
    "",
    "## Non-escalated deviations",
    ...(deviationLines.length > 0 ? deviationLines : ["- None recorded"]),
    "",
    "## Escalation decisions",
    ...(escalationLines.length > 0 ? escalationLines : ["- None recorded"]),
    "",
    "## Known limitations",
    ...bullets(evidence.plan?.protectedZoneExpectations ?? [], "None stated"),
    "",
    "## Remaining maintainer decisions",
    "- Review and merge remain entirely with the maintainer; RoadmapOS never merges, deploys, releases, or publishes.",
    "",
    "## Authorization record",
    `- **Execution plan:** ${evidence.planVersion === null ? "not applicable (interactive copilot)" : `v${String(evidence.planVersion)}`}`,
    `- **Plan content hash:** \`${evidence.planHash ?? "not applicable"}\``,
    `- **Policy hash:** \`${evidence.policyHash}\``,
    `- **Base SHA:** \`${evidence.run.baseSha}\``,
    `- **Branch:** \`${evidence.run.branchName}\``,
    `- **Issue:** #${String(evidence.item.githubIssueNumber)}`,
    `- **Condition:** ${evidence.run.condition}`
  ].join("\n");
}
