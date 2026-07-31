import { beforeEach, expect, it } from "vitest";
import { createDatabase } from "@roadmapos/db";
import { resetTestDatabase } from "@roadmapos/testkit";
import { EscalationService } from "../src/services/escalation-service.js";
import { PullRequestService } from "../src/services/pull-request-service.js";
import {
  runEscalationApprovalFixture,
  runPlanQuorumRestorationFixture,
  seedPullRequestFixture,
  seedRevealedCheckpointFixture
} from "./support/delivery-fixture.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabase(url);

beforeEach(async () => resetTestDatabase(url));

it("creates a hashed escalation after an operator pause", async () => {
  const fixture = await seedRevealedCheckpointFixture(database, { operatorDecision: "pause_and_escalate", protectedPath: "src/auth/**" });
  const escalation = await new EscalationService(database, fixture.github).create(fixture.checkpointId);
  expect(escalation.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(escalation.payload.protectedZones).toEqual(["protected_zone:src/auth/**"]);
  expect(fixture.github.comments.at(-1)).toContain(`/roadmapos approve-escalation ${String(escalation.version)}`);
});

it("refuses to escalate a checkpoint the operator allowed to continue", async () => {
  const fixture = await seedRevealedCheckpointFixture(database, { operatorDecision: "continue", protectedPath: "src/auth/**" });
  await expect(new EscalationService(database, fixture.github).create(fixture.checkpointId))
    .rejects.toThrow("Escalation requires an operator pause decision");
});

it("executes an exact frozen action after escalation quorum without rewriting the operator pause", async () => {
  const result = await runEscalationApprovalFixture(database, { permissionAfterApproval: "maintain" });
  expect(result.liveGateDecision).toBe("pause_and_escalate");
  expect(result.escalationStatus).toBe("approved");
  expect(result.proposalStatus).toBe("executed");
  expect(result.runState).toBe("proposing_action");
});

it("invalidates permission-lost approvals and waits for a replacement quorum", async () => {
  const result = await runEscalationApprovalFixture(database, { permissionAfterApproval: "read" });
  expect(result.liveGateDecision).toBe("pause_and_escalate");
  expect(result.invalidatedApprovalCount).toBe(1);
  expect(result.escalationStatus).toBe("awaiting_approval");
  expect(result.proposalStatus).toBe("proposed");
  expect(result.runState).toBe("awaiting_escalation_approval");
});

it("restores plan quorum and resumes the exact frozen action", async () => {
  const result = await runPlanQuorumRestorationFixture(database, { gateDecision: "continue" });
  expect(result.invalidatedPlanApprovalCount).toBe(1);
  expect(result.replacementApprovalCount).toBe(1);
  expect(result.originalProposalId).toBe(result.executedProposalId);
  expect(result.proposalCount).toBe(1);
  expect(result.finalRunState).toBe("proposing_action");
});

it("renders every non-escalated deviation in the draft PR", async () => {
  const fixture = await seedPullRequestFixture(database, { deviationCount: 1 });
  const pullRequest = await new PullRequestService(database, fixture.github).openDraft(fixture.runId, "Fix parser behavior", fixture.proposalId);
  expect(fixture.github.pullRequests[0]?.body).toContain("## Non-escalated deviations");
  expect(fixture.github.pullRequests[0]?.body).toContain("shared sanitizer");
  expect(pullRequest.number).toBe(12);
});

it("derives the pull-request body from durable evidence and never from the model's body", async () => {
  const fixture = await seedPullRequestFixture(database, { deviationCount: 0 });
  await new PullRequestService(database, fixture.github).openDraft(fixture.runId, "Fix parser behavior", fixture.proposalId);
  const body = fixture.github.pullRequests[0]?.body ?? "";
  for (const heading of [
    "## Why", "## What changed", "## Acceptance criteria and evidence", "## Tests and validation",
    "## Risk and rollback", "## Non-escalated deviations", "## Escalation decisions",
    "## Known limitations", "## Remaining maintainer decisions", "## Authorization record"
  ]) {
    expect(body).toContain(heading);
  }
  expect(body).not.toContain("ignored");
  expect(body).toContain("RoadmapOS never merges, deploys, releases, or publishes");
});

it("opens at most one draft pull request per run", async () => {
  const fixture = await seedPullRequestFixture(database, { deviationCount: 0 });
  const service = new PullRequestService(database, fixture.github);
  const first = await service.openDraft(fixture.runId, "Fix parser behavior", fixture.proposalId);
  const second = await service.openDraft(fixture.runId, "Fix parser behavior", fixture.proposalId);
  expect(second.number).toBe(first.number);
  expect(fixture.github.pullRequests).toHaveLength(1);
});
