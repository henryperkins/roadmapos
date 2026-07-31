import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@roadmapos/db";
import { DeterministicFakeAgentGateway } from "@roadmapos/agent";
import { FakeGitHubGateway, resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";
import { PlanService } from "../src/services/plan-service.js";
import { ApprovalService } from "../src/services/approval-service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabase(url);

beforeEach(async () => resetTestDatabase(url));

describe("immutable plan approval", () => {
  it("requires live maintain permission and one approval for the exact hash", async () => {
    const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "planning", executionPlanQuorum: 1 });
    const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
    const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
    const plan = await new PlanService(database, agent, github).generateInitialPlan(fixture.runId);
    const result = await new ApprovalService(database, github).approvePlan({
      runId: fixture.runId,
      version: plan.version,
      hashPrefix: plan.contentHash.slice(0, 16),
      githubUserId: "42",
      githubLogin: "maintainer",
      githubCommentId: "700"
    });
    expect(result.quorumReached).toBe(true);
    expect(result.permission).toBe("maintain");
  });

  it("publishes the immutable hash and the exact approval command", async () => {
    const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "planning" });
    const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
    const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
    const plan = await new PlanService(database, agent, github).generateInitialPlan(fixture.runId);
    expect(github.comments.at(-1)).toContain(plan.contentHash);
    expect(github.comments.at(-1)).toContain(`/roadmapos approve-plan 1 ${plan.contentHash.slice(0, 16)}`);
  });

  it("rejects write permission when policy requires maintain", async () => {
    const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "planning", executionPlanQuorum: 1 });
    const github = new FakeGitHubGateway({ permission: "write", branchHead: fixture.baseSha });
    const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
    const plan = await new PlanService(database, agent, github).generateInitialPlan(fixture.runId);
    await expect(new ApprovalService(database, github).approvePlan({
      runId: fixture.runId,
      version: plan.version,
      hashPrefix: plan.contentHash.slice(0, 16),
      githubUserId: "42",
      githubLogin: "maintainer",
      githubCommentId: "701"
    })).rejects.toThrow("requires maintain permission");
  });

  it("rejects a hash prefix that does not match the immutable plan", async () => {
    const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "planning" });
    const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
    const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
    const plan = await new PlanService(database, agent, github).generateInitialPlan(fixture.runId);
    await expect(new ApprovalService(database, github).approvePlan({
      runId: fixture.runId,
      version: plan.version,
      hashPrefix: "0".repeat(16),
      githubUserId: "42",
      githubLogin: "maintainer",
      githubCommentId: "702"
    })).rejects.toThrow("Plan hash prefix does not match");
  });

  it("rejects approval after the base branch moved", async () => {
    const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "planning" });
    const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
    const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
    const plan = await new PlanService(database, agent, github).generateInitialPlan(fixture.runId);
    github.setBranchHead("f".repeat(40));
    await expect(new ApprovalService(database, github).approvePlan({
      runId: fixture.runId,
      version: plan.version,
      hashPrefix: plan.contentHash.slice(0, 16),
      githubUserId: "42",
      githubLogin: "maintainer",
      githubCommentId: "703"
    })).rejects.toThrow("Base branch changed");
  });

  it("invalidates an approver who loses permission and allows quorum to be restored", async () => {
    const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "planning", executionPlanQuorum: 2 });
    const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
    const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], fixture.classifier);
    const plan = await new PlanService(database, agent, github).generateInitialPlan(fixture.runId);
    const approvals = new ApprovalService(database, github);

    await approvals.approvePlan({ runId: fixture.runId, version: 1, hashPrefix: plan.contentHash.slice(0, 16), githubUserId: "41", githubLogin: "maintainer-a", githubCommentId: "710" });
    github.setPermission("maintainer-a", "read");
    const second = await approvals.approvePlan({ runId: fixture.runId, version: 1, hashPrefix: plan.contentHash.slice(0, 16), githubUserId: "42", githubLogin: "maintainer-b", githubCommentId: "711" });
    expect(second.quorumReached).toBe(false);
    expect(second.invalidatedApprovals).toEqual(["maintainer-a"]);

    const restored = await approvals.approvePlan({ runId: fixture.runId, version: 1, hashPrefix: plan.contentHash.slice(0, 16), githubUserId: "43", githubLogin: "maintainer-c", githubCommentId: "712" });
    expect(restored.quorumReached).toBe(true);
  });
});
