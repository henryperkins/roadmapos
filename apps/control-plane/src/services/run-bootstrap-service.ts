import { enqueueJob, ExecutionRepository, runs, type Database } from "@roadmapos/db";
import type { GitHubGateway } from "@roadmapos/github";
import type { Condition } from "@roadmapos/domain";

export class RunBootstrapService {
  constructor(
    private readonly database: Database,
    private readonly github: GitHubGateway,
    private readonly execution = new ExecutionRepository(database)
  ) {}

  async start(input: {
    pilotId: string;
    workItemId: string;
    repositoryId: string;
    policyVersionId: string;
    condition: Condition;
    installationId: string;
    owner: string;
    repo: string;
    defaultBranch: string;
  }): Promise<string> {
    const baseSha = await this.github.getBranchHead({ installationId: input.installationId, owner: input.owner, repo: input.repo, branch: input.defaultBranch });
    const runId = crypto.randomUUID();
    const branchName = `roadmapos/${runId}`;
    await this.database.db.insert(runs).values({
      id: runId,
      pilotId: input.pilotId,
      workItemId: input.workItemId,
      repositoryId: input.repositoryId,
      policyVersionId: input.policyVersionId,
      condition: input.condition,
      state: "registered",
      baseSha,
      branchName
    });
    await this.execution.transition({
      runId,
      event: { type: "analysis_started" },
      actorType: "github",
      actorId: "ready-label"
    });
    await enqueueJob(this.database, input.condition === "governed_orchestration" ? "plan.generate" : "interactive.prompt_next", { runId });
    return runId;
  }
}
