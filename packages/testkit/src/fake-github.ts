import type {
  BranchHeadQuery,
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
} from "@roadmapos/github";
import type { RepositoryPermission } from "@roadmapos/domain";

export interface FakeGitHubFixture {
  permission: RepositoryPermission;
  branchHead: string;
  files?: Record<string, string>;
  permissions?: Record<string, RepositoryPermission>;
  branchProtection?: BranchProtectionRecord;
}

export class FakeGitHubGateway implements GitHubGateway, GitHubCredentialProvider {
  readonly comments: string[] = [];
  readonly checks: Array<{ title: string; summary: string; detailsUrl: string }> = [];
  readonly pullRequests: DraftPullRequestInput[] = [];
  readonly permissionQueries: string[] = [];

  constructor(private readonly fixture: FakeGitHubFixture) {}

  setPermission(login: string, permission: RepositoryPermission): void {
    this.fixture.permissions ??= {};
    this.fixture.permissions[login] = permission;
  }

  setBranchHead(sha: string): void {
    this.fixture.branchHead = sha;
  }

  async createInstallationToken(installationId: string): Promise<string> {
    return `fake-installation-token-${installationId}`;
  }

  async getRepositoryPermission(input: GitHubPermissionQuery): Promise<RepositoryPermission> {
    this.permissionQueries.push(input.login);
    return this.fixture.permissions?.[input.login] ?? this.fixture.permission;
  }

  async publishIssueComment(input: IssueCommentInput): Promise<PublishedRecord> {
    this.comments.push(input.body);
    return { id: String(this.comments.length), url: `https://example.test/comment/${String(this.comments.length)}` };
  }

  async publishCheck(input: CheckInput): Promise<PublishedRecord> {
    this.checks.push({ title: input.title, summary: input.summary, detailsUrl: input.detailsUrl });
    return { id: String(this.checks.length), url: null };
  }

  async openDraftPullRequest(input: DraftPullRequestInput): Promise<DraftPullRequestRecord> {
    this.pullRequests.push(input);
    return { id: "900", number: 12, nodeId: "PR_12", url: "https://example.test/pull/12" };
  }

  async getBranchHead(_input: BranchHeadQuery): Promise<string> {
    return this.fixture.branchHead;
  }

  async getFile(input: RepositoryFileQuery): Promise<string> {
    const value = this.fixture.files?.[input.path];
    if (value === undefined) throw new Error(`Missing fixture file: ${input.path}`);
    return value;
  }

  async getBranchProtection(): Promise<BranchProtectionRecord> {
    return this.fixture.branchProtection ?? { enabled: true, requiredApprovals: 1 };
  }
}
