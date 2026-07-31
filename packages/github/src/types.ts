import type { RepositoryPermission } from "@roadmapos/domain";

export interface GitHubPermissionQuery {
  installationId: string;
  owner: string;
  repo: string;
  login: string;
}

export interface BranchHeadQuery {
  installationId: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface RepositoryFileQuery {
  installationId: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

export type BranchProtectionQuery = BranchHeadQuery;
export interface BranchProtectionRecord { enabled: boolean; requiredApprovals: number }

export interface IssueCommentInput {
  installationId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

export interface CheckInput {
  installationId: string;
  owner: string;
  repo: string;
  headSha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "action_required";
  title: string;
  summary: string;
  detailsUrl: string;
}

export interface DraftPullRequestInput {
  installationId: string;
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

export interface PublishedRecord { id: string; url: string | null }
export interface DraftPullRequestRecord extends PublishedRecord { number: number; nodeId: string }

export interface GitHubGateway {
  getRepositoryPermission(input: GitHubPermissionQuery): Promise<RepositoryPermission>;
  publishIssueComment(input: IssueCommentInput): Promise<PublishedRecord>;
  publishCheck(input: CheckInput): Promise<PublishedRecord>;
  openDraftPullRequest(input: DraftPullRequestInput): Promise<DraftPullRequestRecord>;
  getBranchHead(input: BranchHeadQuery): Promise<string>;
  getFile(input: RepositoryFileQuery): Promise<string>;
  getBranchProtection(input: BranchProtectionQuery): Promise<BranchProtectionRecord>;
}

/**
 * Minting an installation token is deliberately separate from `GitHubGateway`. Only the workspace
 * boundary needs a raw token; nothing that builds an agent prompt may depend on this interface.
 */
export interface GitHubCredentialProvider {
  createInstallationToken(installationId: string): Promise<string>;
}
