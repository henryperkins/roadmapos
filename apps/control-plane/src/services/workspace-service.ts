import { eq } from "drizzle-orm";
import { repositories, repositoryPolicyVersions, runs, type Database } from "@roadmapos/db";
import type { GitHubCredentialProvider } from "@roadmapos/github";
import type { RepositoryPolicy } from "@roadmapos/policy";
import type { WorkspaceHandle, WorkspaceRunner } from "@roadmapos/runner";

/**
 * Owns the only path that mints an installation token for repository work. The token is returned
 * to the caller for the single git operation that needs it and is never stored on the handle, put
 * into a transcript entry, or reachable from anything that builds an agent prompt.
 */
export class WorkspaceService {
  private readonly handles = new Map<string, WorkspaceHandle>();

  constructor(private readonly database: Database, private readonly credentials: GitHubCredentialProvider, private readonly runner: WorkspaceRunner) {}

  async get(runId: string): Promise<{ handle: WorkspaceHandle; token: string }> {
    const [record] = await this.database.db.select({ run: runs, repository: repositories, policy: repositoryPolicyVersions })
      .from(runs)
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .where(eq(runs.id, runId));
    if (!record) throw new Error("Run not found");
    const token = await this.credentials.createInstallationToken(record.repository.installationId.toString());
    const cached = this.handles.get(runId);
    if (cached) return { handle: cached, token };
    const policy = record.policy.policyJson as RepositoryPolicy;
    const handle = await this.runner.prepare({
      runId,
      cloneUrl: `https://github.com/${record.repository.owner}/${record.repository.name}.git`,
      installationToken: token,
      baseSha: record.run.baseSha,
      branchName: record.run.branchName,
      readablePaths: policy.execution.readablePaths,
      validationCommands: policy.execution.validationCommands
    });
    this.handles.set(runId, handle);
    return { handle, token };
  }
}
