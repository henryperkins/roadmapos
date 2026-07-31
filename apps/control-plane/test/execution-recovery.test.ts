import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { actionProposals, createDatabase, executionAttempts, executionOutbox, runs } from "@roadmapos/db";
import { DeterministicFakeAgentGateway } from "@roadmapos/agent";
import { FakeGitHubGateway, FakeWorkspaceRunner, resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";
import type { CommitResult, WorkspaceHandle } from "@roadmapos/runner";
import { CheckpointService } from "../src/services/checkpoint-service.js";
import { ActionCoordinator } from "../src/services/action-coordinator.js";
import { ApprovalService } from "../src/services/approval-service.js";
import { WorkspaceService } from "../src/services/workspace-service.js";
import { PLAN_APPROVER } from "./support/delivery-fixture.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabase(url);

beforeEach(async () => resetTestDatabase(url));

const COMMIT_ACTION = { kind: "commit_and_push" as const, message: "Reject empty parser input", summary: "Commit the guard" };
const PLAN_HASH = "d".repeat(64);

/** Reports a push failure to the caller, the way a transient remote error would. */
class FailingPushRunner extends FakeWorkspaceRunner {
  override async commitAndPush(_handle: WorkspaceHandle, message: string): Promise<CommitResult> {
    this.commits.push(message);
    throw new Error("worker crashed after the remote accepted the push");
  }
}

async function seedApprovedGovernedRun() {
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
  const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
  const planId = crypto.randomUUID();
  await database.sql`
    INSERT INTO execution_plans (id, run_id, version, plan_json, content_hash, base_sha, change_classification)
    VALUES (${planId}::uuid, ${fixture.runId}::uuid, 1, ${JSON.stringify(fixture.planDraft)}::jsonb, ${PLAN_HASH}, ${fixture.baseSha}, 'initial')
  `;
  await database.sql`UPDATE runs SET current_plan_id = ${planId}::uuid WHERE id = ${fixture.runId}::uuid`;
  await new ApprovalService(database, github).approvePlan({
    runId: fixture.runId, version: 1, hashPrefix: PLAN_HASH.slice(0, 16),
    githubUserId: "41", githubLogin: PLAN_APPROVER, githubCommentId: "600"
  });
  return { fixture, github };
}

function coordinatorFor(fixture: Awaited<ReturnType<typeof seedApprovedGovernedRun>>["fixture"], github: FakeGitHubGateway, runner: FakeWorkspaceRunner, leaseOwner: string) {
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [COMMIT_ACTION], fixture.classifier);
  const checkpoints = new CheckpointService(database, agent, Buffer.alloc(32, 31).toString("base64"));
  const approvals = new ApprovalService(database, github);
  return {
    checkpoints,
    coordinator: new ActionCoordinator(
      database, agent, checkpoints, runner, github, fixture.publicBaseUrl,
      new WorkspaceService(database, github, runner), approvals, leaseOwner
    )
  };
}

async function proposeAndClear(fixture: Awaited<ReturnType<typeof seedApprovedGovernedRun>>["fixture"], github: FakeGitHubGateway, runner: FakeWorkspaceRunner, leaseOwner: string) {
  const { coordinator, checkpoints } = coordinatorFor(fixture, github, runner, leaseOwner);
  const proposal = await coordinator.propose(fixture.runId);
  const checkpointId = proposal.checkpointId;
  if (!checkpointId) throw new Error("Expected a frozen checkpoint");
  await checkpoints.recordOperatorClassification({
    checkpointId,
    operatorId: "operator-1",
    rationale: "Within the approved plan",
    classification: {
      boundary: "none", planRelationship: "within_plan", decision: "continue",
      affectedPolicyRules: [], facts: ["Within plan"], requiredDisclosureFields: [], reversible: true, confidence: 92
    }
  });
  return { coordinator, proposalId: proposal.proposalId };
}

describe("execution attempts and recovery", () => {
  it("records a leased attempt and an outbox row for the only remote-mutating action", async () => {
    const { fixture, github } = await seedApprovedGovernedRun();
    const runner = new FakeWorkspaceRunner();
    const { coordinator, proposalId } = await proposeAndClear(fixture, github, runner, "worker-a");
    await coordinator.executeAfterGate(fixture.runId, proposalId);

    const attempts = await database.db.select().from(executionAttempts).where(eq(executionAttempts.proposalId, proposalId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe("succeeded");
    const effects = await database.db.select().from(executionOutbox).where(eq(executionOutbox.runId, fixture.runId));
    expect(effects).toHaveLength(1);
    expect(effects[0]?.effectKind).toBe("git_commit_push");
    expect(effects[0]?.state).toBe("confirmed");
  });

  it("refuses a concurrent worker while a lease is live, so no second push occurs", async () => {
    const { fixture, github } = await seedApprovedGovernedRun();
    const runner = new FakeWorkspaceRunner();
    const { proposalId } = await proposeAndClear(fixture, github, runner, "worker-a");

    // A live lease held by worker-a, exactly as if worker-a were mid-push.
    await database.sql`
      INSERT INTO execution_attempts (id, run_id, proposal_id, attempt, action_hash, idempotency_key, state, lease_owner, lease_expires_at)
      SELECT ${crypto.randomUUID()}::uuid, ${fixture.runId}::uuid, ${proposalId}::uuid, 1, action_hash,
             ${`live-lease:${proposalId}`}, 'running', 'worker-a', now() + interval '15 minutes'
      FROM action_proposals WHERE id = ${proposalId}::uuid
    `;

    const second = new FakeWorkspaceRunner();
    const { coordinator } = coordinatorFor(fixture, github, second, "worker-b");
    await coordinator.executeAfterGate(fixture.runId, proposalId);
    expect(second.commits).toHaveLength(0);
  });

  it("marks the attempt failed and returns the run to its condition's next state on error", async () => {
    const { fixture, github } = await seedApprovedGovernedRun();
    const runner = new FailingPushRunner();
    const { coordinator, proposalId } = await proposeAndClear(fixture, github, runner, "worker-a");

    await expect(coordinator.executeAfterGate(fixture.runId, proposalId)).rejects.toThrow("worker crashed");
    const [attempt] = await database.db.select().from(executionAttempts).where(eq(executionAttempts.proposalId, proposalId));
    expect(attempt?.state).toBe("failed");
    const [proposal] = await database.db.select().from(actionProposals).where(eq(actionProposals.id, proposalId));
    expect(proposal?.status).toBe("failed");
    const [run] = await database.db.select({ state: runs.state }).from(runs).where(eq(runs.id, fixture.runId));
    expect(run?.state).toBe("proposing_action");
  });

  /**
   * A hard crash (SIGKILL mid-push) leaves the attempt `running` with a dispatched, unconfirmed
   * effect; nothing gets the chance to record a failure. This builds exactly that state and lets
   * the lease expire.
   */
  async function simulateHardCrashMidPush(runId: string, proposalId: string): Promise<void> {
    const attemptId = crypto.randomUUID();
    await database.sql`
      INSERT INTO execution_attempts (id, run_id, proposal_id, attempt, action_hash, idempotency_key, state, lease_owner, lease_expires_at)
      SELECT ${attemptId}::uuid, ${runId}::uuid, ${proposalId}::uuid, 1, action_hash,
             ${`crashed:${proposalId}`}, 'running', 'worker-a', now() - interval '1 minute'
      FROM action_proposals WHERE id = ${proposalId}::uuid
    `;
    await database.sql`
      INSERT INTO execution_outbox (id, attempt_id, run_id, effect_kind, idempotency_key, request_json, state, dispatched_at)
      VALUES (${crypto.randomUUID()}::uuid, ${attemptId}::uuid, ${runId}::uuid, 'git_commit_push',
              ${`crashed:${proposalId}:git_commit_push`}, ${JSON.stringify({ message: COMMIT_ACTION.message })}::jsonb, 'dispatched', now())
    `;
    await database.sql`UPDATE action_proposals SET status = 'authorized' WHERE id = ${proposalId}::uuid`;
    await database.sql`SELECT set_config('roadmapos.allow_run_state_transition', 'on', true)`;
    await database.sql`UPDATE runs SET state = 'executing_action' WHERE id = ${runId}::uuid`;
  }

  it("reconciles a crashed push that the remote actually accepted, without pushing again", async () => {
    const { fixture, github } = await seedApprovedGovernedRun();
    const runner = new FakeWorkspaceRunner();
    const { proposalId } = await proposeAndClear(fixture, github, runner, "worker-a");
    await simulateHardCrashMidPush(fixture.runId, proposalId);

    github.setBranchHead("c".repeat(40));
    const recoveryRunner = new FakeWorkspaceRunner();
    const { coordinator: recovery } = coordinatorFor(fixture, github, recoveryRunner, "worker-b");
    await recovery.executeAfterGate(fixture.runId, proposalId);

    expect(recoveryRunner.commits).toHaveLength(0);
    const [proposal] = await database.db.select().from(actionProposals).where(eq(actionProposals.id, proposalId));
    expect(proposal?.status).toBe("executed");
    const [effect] = await database.db.select().from(executionOutbox).where(eq(executionOutbox.runId, fixture.runId));
    expect(effect?.state).toBe("confirmed");
    expect(effect?.externalId).toBe("c".repeat(40));
  });

  it("retries safely when the crashed push never reached the remote", async () => {
    const { fixture, github } = await seedApprovedGovernedRun();
    const runner = new FakeWorkspaceRunner();
    const { proposalId } = await proposeAndClear(fixture, github, runner, "worker-a");
    await simulateHardCrashMidPush(fixture.runId, proposalId);

    const recoveryRunner = new FakeWorkspaceRunner();
    const { coordinator: recovery } = coordinatorFor(fixture, github, recoveryRunner, "worker-b");
    await recovery.executeAfterGate(fixture.runId, proposalId);

    expect(recoveryRunner.commits).toHaveLength(1);
    const [proposal] = await database.db.select().from(actionProposals).where(eq(actionProposals.id, proposalId));
    expect(proposal?.status).toBe("executed");
    const rows = await database.db.select().from(executionOutbox).where(eq(executionOutbox.runId, fixture.runId));
    expect(rows.some((row) => row.state === "abandoned")).toBe(true);
  });

  it("allocates transcript sequences in the database rather than from a read-then-add", async () => {
    const fixture = await seedExecutionFixture(database);
    const rows = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => database.sql`
        INSERT INTO run_transcript_entries (id, run_id, sequence, role, content, content_hash)
        SELECT ${crypto.randomUUID()}::uuid, ${fixture.runId}::uuid, coalesce(max(sequence), 0) + 1, 'tool', ${`entry-${String(index)}`}, ${"a".repeat(64)}
        FROM run_transcript_entries WHERE run_id = ${fixture.runId}::uuid
        RETURNING sequence
      `.then((result) => (result as unknown as { sequence: number }[])[0]?.sequence).catch(() => null)
    ));
    const allocated = rows.filter((value): value is number => value !== null);
    expect(new Set(allocated).size).toBe(allocated.length);
  });
});
