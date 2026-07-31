import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { RepositoryPermission } from "@roadmapos/domain";
import type {
  BranchHeadQuery,
  BranchProtectionQuery,
  BranchProtectionRecord,
  CheckInput,
  DraftPullRequestInput,
  DraftPullRequestRecord,
  GitHubCredentialProvider,
  GitHubGateway,
  GitHubPermissionQuery,
  IssueCommentInput,
  PublishedRecord,
  RepositoryFileQuery
} from "./types.js";

const allowedPermissions = new Set<RepositoryPermission>(["none", "read", "triage", "write", "maintain", "admin"]);

export class OctokitGitHubGateway implements GitHubGateway, GitHubCredentialProvider {
  constructor(private readonly appId: string, private readonly privateKey: string) {}

  async createInstallationToken(installationId: string): Promise<string> {
    const auth = createAppAuth({ appId: this.appId, privateKey: this.privateKey, installationId: Number(installationId) });
    const installation = await auth({ type: "installation" });
    return installation.token;
  }

  private async client(installationId: string): Promise<Octokit> {
    return new Octokit({ auth: await this.createInstallationToken(installationId) });
  }

  async getRepositoryPermission(input: GitHubPermissionQuery): Promise<RepositoryPermission> {
    const octokit = await this.client(input.installationId);
    const response = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner: input.owner, repo: input.repo, username: input.login });
    const permission = response.data.permission as RepositoryPermission;
    if (!allowedPermissions.has(permission)) throw new Error(`Unsupported GitHub permission: ${permission}`);
    return permission;
  }

  async publishIssueComment(input: IssueCommentInput): Promise<PublishedRecord> {
    const octokit = await this.client(input.installationId);
    const response = await octokit.rest.issues.createComment({ owner: input.owner, repo: input.repo, issue_number: input.issueNumber, body: input.body });
    return { id: String(response.data.id), url: response.data.html_url };
  }

  async publishCheck(input: CheckInput): Promise<PublishedRecord> {
    const octokit = await this.client(input.installationId);
    const response = await octokit.rest.checks.create({
      owner: input.owner,
      repo: input.repo,
      head_sha: input.headSha,
      name: input.name,
      status: input.status,
      ...(input.status === "completed" && input.conclusion ? { conclusion: input.conclusion } : {}),
      details_url: input.detailsUrl,
      output: { title: input.title, summary: input.summary }
    });
    return { id: String(response.data.id), url: response.data.html_url ?? null };
  }

  async openDraftPullRequest(input: DraftPullRequestInput): Promise<DraftPullRequestRecord> {
    const octokit = await this.client(input.installationId);
    const response = await octokit.rest.pulls.create({ owner: input.owner, repo: input.repo, base: input.base, head: input.head, title: input.title, body: input.body, draft: true });
    return { id: String(response.data.id), number: response.data.number, nodeId: response.data.node_id, url: response.data.html_url };
  }

  async getBranchHead(input: BranchHeadQuery): Promise<string> {
    const octokit = await this.client(input.installationId);
    const response = await octokit.rest.repos.getBranch({ owner: input.owner, repo: input.repo, branch: input.branch });
    return response.data.commit.sha;
  }

  async getFile(input: RepositoryFileQuery): Promise<string> {
    const octokit = await this.client(input.installationId);
    const response = await octokit.rest.repos.getContent({ owner: input.owner, repo: input.repo, path: input.path, ref: input.ref });
    if (Array.isArray(response.data) || response.data.type !== "file" || !response.data.content) throw new Error(`GitHub path is not a file: ${input.path}`);
    return Buffer.from(response.data.content, response.data.encoding as BufferEncoding).toString("utf8");
  }

  async getBranchProtection(input: BranchProtectionQuery): Promise<BranchProtectionRecord> {
    const octokit = await this.client(input.installationId);
    try {
      const response = await octokit.rest.repos.getBranchProtection({ owner: input.owner, repo: input.repo, branch: input.branch });
      return { enabled: true, requiredApprovals: response.data.required_pull_request_reviews?.required_approving_review_count ?? 0 };
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as Error & { status: number }).status === 404) return { enabled: false, requiredApprovals: 0 };
      throw error;
    }
  }
}
