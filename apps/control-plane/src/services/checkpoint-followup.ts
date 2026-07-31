import { eq } from "drizzle-orm";
import { enqueueJob, governanceCheckpoints, repositories, runs, workItems, type Database } from "@roadmapos/db";
import type { GitHubGateway } from "@roadmapos/github";
import type { DeviationService } from "./deviation-service.js";
import type { RevealedJudgmentComparison } from "./checkpoint-service.js";

/**
 * The single place that decides what happens after a checkpoint is revealed. It never re-decides
 * the gate: it reads the operator's committed decision and enqueues exactly the follow-up that
 * decision authorizes.
 */
export class CheckpointFollowUpService {
  constructor(
    private readonly database: Database,
    private readonly deviations: DeviationService,
    private readonly github: GitHubGateway
  ) {}

  async dispatch(checkpointId: string, revealed: RevealedJudgmentComparison, operatorId: string): Promise<void> {
    const [record] = await this.database.db
      .select({ checkpoint: governanceCheckpoints, run: runs, repository: repositories, item: workItems })
      .from(governanceCheckpoints)
      .innerJoin(runs, eq(runs.id, governanceCheckpoints.runId))
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .where(eq(governanceCheckpoints.id, checkpointId));
    if (!record) throw new Error("Checkpoint not found");

    if (record.checkpoint.source === "plan_revision") {
      await enqueueJob(this.database, "run.apply_revision_decision", { checkpointId, operatorId });
      return;
    }

    if (revealed.liveDecision === "continue") {
      // The disclosure is written before the action runs, so an execution failure cannot erase the
      // record that a variation was allowed to proceed.
      await this.deviations.recordIfRequired(checkpointId);
      if (record.checkpoint.actionProposalId) {
        await enqueueJob(this.database, "run.execute_action", { runId: record.run.id, proposalId: record.checkpoint.actionProposalId });
      }
      return;
    }

    if (revealed.liveDecision === "pause_and_escalate") {
      await enqueueJob(this.database, "run.create_escalation", { checkpointId });
      return;
    }

    await this.github.publishIssueComment({
      installationId: record.repository.installationId.toString(),
      owner: record.repository.owner,
      repo: record.repository.name,
      issueNumber: record.item.githubIssueNumber,
      body: [
        "## RoadmapOS run stopped",
        "",
        "An independent operator classified this checkpoint as **stop**. No further repository write will be attempted for this run.",
        "",
        `Checkpoint: \`${checkpointId}\``
      ].join("\n")
    });
  }
}
