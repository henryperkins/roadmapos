# RoadmapOS Supervised GitHub Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement both pilot conditions from GitHub readiness through a supervised draft pull request, with immutable authorization, restricted repository execution, blind agent/operator checkpoint classification, escalation, and public deviation disclosure.

**Architecture:** Extend the governance core with execution tables and a pure run-state reducer. GitHub webhooks enqueue idempotent jobs. The agent produces only Zod-validated plans, classifications, and one-step action proposals; it never receives a raw GitHub token and never executes shell commands directly. A restricted workspace runner applies unified diffs and predefined validation commands only after the checkpoint service records the hidden agent label and the operator independently allows the action.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Drizzle ORM, Octokit, OpenAI Agents SDK, Zod, Git, Docker, Next.js, React, Vitest, Playwright.

## Global Constraints

- Follow every global constraint in `docs/superpowers/plans/2026-07-20-roadmapos-governed-orchestration-pilot-master-REVIEW-REVISION.md`.
- GitHub readiness is represented in the pilot by the configurable label `roadmapos:ready`; applying it authorizes analysis and plan generation only.
- Maintainer commands are issue or pull-request comments beginning with `/roadmapos` and are recorded verbatim with GitHub actor ID, comment ID, repository permission, base SHA, and timestamp.
- Condition A authorizes one proposed consequential action at a time; Condition B authorizes execution under one approved immutable plan until a pause or stop decision.
- Raw model output is never executed. Every model response passes a Zod schema and policy evaluation.
- Agent-proposed shell strings are not accepted. Validation runs select a command ID already present in the policy snapshot.
- Workspace containers have no GitHub token, no host Docker socket, no privileged mode, no added Linux capabilities, and no network during agent-driven validation.
- The GitHub App has no merge, deployment, environment, administration, or package-write permissions.
- A `platform_hard_stop` classification can resolve only to `stop`; a `repository_protected` classification can resolve only to `pause_and_escalate` or `stop`. The server enforces this independently of prompts and UI controls.
- The initial operator pause record remains immutable after escalation approval. Execution authorization records the later approved escalation as a separate source; it never rewrites the pause into a continue.
- Every `runs.state` change goes through `ExecutionRepository`; a PostgreSQL trigger rejects unmanaged state updates.
- A draft pull request is the terminal repository write. Formal review and merge remain outside the worker.

## File structure

- `packages/domain/`: execution-plan, action, checkpoint, escalation, deviation, and run-state contracts plus pure reducers.
- `packages/github/`: GitHub App authentication and a narrow `GitHubGateway`; no workflow or policy decisions live here.
- `packages/agent/`: structured model-provider adapter and deterministic fake; it returns validated artifacts but never executes them.
- `packages/runner/`: isolated checkout, patch, validation, commit, and push capabilities behind a token-minimizing interface.
- `packages/db/`: execution, approval, checkpoint, authorization, and pull-request persistence.
- `apps/control-plane/`: webhook ingestion, durable jobs, workflow services, the shared action coordinator, and operator checkpoint APIs.
- `apps/portal/`: the blind operator classification interface only in this milestone.

---

### Task 7: Add execution persistence and a pure run-state reducer

**Files:**
- Create: `packages/db/src/migrations/0002_execution_workflows.sql`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/execution-repository.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/domain/src/run-events.ts`
- Create: `packages/domain/src/run-reducer.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/test/run-reducer.test.ts`
- Create: `packages/db/test/execution-workflows.test.ts`
- Create: `packages/testkit/src/execution-fixture.ts`
- Modify: `packages/testkit/src/index.ts`

**Interfaces:**
- Consumes: `RunState`, `Condition`, canonical hashes, and the core database.
- Produces: `RunEventSchema`, `reduceRunState`, `ExecutionRepository`, and execution tables used by all later tasks.

- [ ] **Step 1: Write failing run-state tests**

```ts
// packages/domain/test/run-reducer.test.ts
import { describe, expect, it } from "vitest";
import { reduceRunState } from "../src/index.js";

describe("reduceRunState", () => {
  it("moves a governed run from registration to plan approval and execution", () => {
    expect(reduceRunState("registered", { type: "analysis_started" }, "governed_orchestration")).toBe("planning");
    expect(reduceRunState("planning", { type: "plan_published" }, "governed_orchestration")).toBe("awaiting_plan_approval");
    expect(reduceRunState("awaiting_plan_approval", { type: "plan_quorum_reached" }, "governed_orchestration")).toBe("proposing_action");
  });

  it("moves an interactive run to the instruction loop after every authorized action", () => {
    expect(reduceRunState("registered", { type: "analysis_started" }, "interactive_copilot")).toBe("awaiting_instruction");
    expect(reduceRunState("executing_action", { type: "action_completed" }, "interactive_copilot")).toBe("awaiting_instruction");
    expect(reduceRunState("awaiting_escalation_approval", { type: "escalation_rejected" }, "interactive_copilot")).toBe("awaiting_instruction");
  });

  it("routes revision decisions and lost quorum without direct state writes", () => {
    expect(reduceRunState("proposing_action", { type: "nonconsequential_action_authorized" }, "governed_orchestration")).toBe("executing_action");
    expect(reduceRunState("proposing_action", { type: "plan_revision_frozen" }, "governed_orchestration")).toBe("awaiting_operator_gate");
    expect(reduceRunState("awaiting_operator_gate", { type: "editorial_revision_accepted" }, "governed_orchestration")).toBe("proposing_action");
    expect(reduceRunState("awaiting_operator_gate", { type: "material_revision_requires_approval" }, "governed_orchestration")).toBe("awaiting_plan_approval");
    expect(reduceRunState("proposing_action", { type: "plan_quorum_lost" }, "governed_orchestration")).toBe("awaiting_plan_approval");
    expect(reduceRunState("executing_action", { type: "plan_quorum_lost" }, "governed_orchestration")).toBe("awaiting_plan_approval");
    expect(reduceRunState("executing_action", { type: "escalation_quorum_lost" }, "governed_orchestration")).toBe("awaiting_escalation_approval");
    expect(reduceRunState("awaiting_plan_approval", { type: "plan_quorum_restored_pending_escalation" }, "governed_orchestration")).toBe("awaiting_escalation_approval");
    expect(reduceRunState("awaiting_plan_approval", { type: "plan_quorum_restored_authorized_action" }, "governed_orchestration")).toBe("executing_action");
  });

  it("rejects a gate approval from the wrong state", () => {
    expect(() => reduceRunState("planning", { type: "operator_continue" }, "governed_orchestration")).toThrow("Invalid run transition");
  });
});
```

- [ ] **Step 2: Define run events and implement the reducer**

```ts
// packages/domain/src/run-events.ts
import { z } from "zod";

export const RunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("analysis_started") }),
  z.object({ type: z.literal("plan_published") }),
  z.object({ type: z.literal("plan_quorum_reached") }),
  z.object({ type: z.literal("plan_quorum_lost") }),
  z.object({ type: z.literal("plan_quorum_restored_pending_escalation") }),
  z.object({ type: z.literal("plan_quorum_restored_authorized_action") }),
  z.object({ type: z.literal("instruction_received") }),
  z.object({ type: z.literal("action_proposed") }),
  z.object({ type: z.literal("nonconsequential_action_authorized") }),
  z.object({ type: z.literal("operator_checkpoint_frozen") }),
  z.object({ type: z.literal("plan_revision_frozen") }),
  z.object({ type: z.literal("operator_continue") }),
  z.object({ type: z.literal("operator_pause") }),
  z.object({ type: z.literal("operator_stop") }),
  z.object({ type: z.literal("editorial_revision_accepted") }),
  z.object({ type: z.literal("material_revision_requires_approval") }),
  z.object({ type: z.literal("action_completed") }),
  z.object({ type: z.literal("escalation_quorum_reached") }),
  z.object({ type: z.literal("escalation_quorum_lost") }),
  z.object({ type: z.literal("escalation_rejected") }),
  z.object({ type: z.literal("draft_pr_opened") }),
  z.object({ type: z.literal("review_ready_declared") }),
  z.object({ type: z.literal("endpoint_verified") }),
  z.object({ type: z.literal("endpoint_rejected") }),
  z.object({ type: z.literal("terminated") })
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
```

```ts
// packages/domain/src/run-reducer.ts
import type { Condition, RunState } from "./enums.js";
import type { RunEvent } from "./run-events.js";

const transitions: Record<RunState, Partial<Record<RunEvent["type"], RunState>>> = {
  registered: { analysis_started: "planning", terminated: "terminated" },
  planning: { plan_published: "awaiting_plan_approval", instruction_received: "proposing_action", terminated: "terminated" },
  awaiting_plan_approval: {
    plan_quorum_reached: "proposing_action",
    plan_quorum_restored_pending_escalation: "awaiting_escalation_approval",
    plan_quorum_restored_authorized_action: "executing_action",
    plan_revision_frozen: "awaiting_operator_gate",
    terminated: "terminated"
  },
  awaiting_instruction: { instruction_received: "proposing_action", terminated: "terminated" },
  proposing_action: {
    action_proposed: "awaiting_operator_gate",
    nonconsequential_action_authorized: "executing_action",
    operator_checkpoint_frozen: "awaiting_operator_gate",
    plan_revision_frozen: "awaiting_operator_gate",
    plan_quorum_lost: "awaiting_plan_approval",
    terminated: "terminated"
  },
  awaiting_operator_gate: {
    operator_continue: "executing_action",
    operator_pause: "awaiting_escalation_approval",
    operator_stop: "terminated",
    editorial_revision_accepted: "proposing_action",
    material_revision_requires_approval: "awaiting_plan_approval",
    plan_quorum_lost: "awaiting_plan_approval",
    terminated: "terminated"
  },
  awaiting_escalation_approval: { escalation_quorum_reached: "executing_action", escalation_rejected: "proposing_action", plan_quorum_lost: "awaiting_plan_approval", terminated: "terminated" },
  executing_action: {
    action_completed: "proposing_action",
    draft_pr_opened: "awaiting_review_ready",
    plan_quorum_lost: "awaiting_plan_approval",
    escalation_quorum_lost: "awaiting_escalation_approval",
    terminated: "terminated"
  },
  awaiting_review_ready: { review_ready_declared: "verifying_endpoint", terminated: "terminated" },
  verifying_endpoint: { endpoint_verified: "completed", endpoint_rejected: "awaiting_review_ready", terminated: "terminated" },
  completed: {},
  terminated: {}
};

export function reduceRunState(current: RunState, event: RunEvent, condition: Condition): RunState {
  if (current === "registered" && event.type === "analysis_started" && condition === "interactive_copilot") {
    return "awaiting_instruction";
  }
  if (current === "planning" && event.type === "instruction_received" && condition !== "interactive_copilot") {
    throw new Error("Invalid run transition: only interactive copilot accepts an instruction from planning");
  }
  if (current === "executing_action" && event.type === "action_completed" && condition === "interactive_copilot") {
    return "awaiting_instruction";
  }
  if (current === "awaiting_escalation_approval" && event.type === "escalation_rejected" && condition === "interactive_copilot") {
    return "awaiting_instruction";
  }
  const next = transitions[current][event.type];
  if (!next) throw new Error(`Invalid run transition: ${current} + ${event.type}`);
  return next;
}
```

- [ ] **Step 3: Export and verify the reducer**

```ts
// packages/domain/src/index.ts additions
export * from "./run-events.js";
export * from "./run-reducer.js";
```

Run:

```bash
pnpm --filter @roadmapos/domain test -- run-reducer.test.ts
```

Expected: all transition tests pass.

- [ ] **Step 4: Create the execution migration**

```sql
-- packages/db/src/migrations/0002_execution_workflows.sql
CREATE TABLE runs (
  id uuid PRIMARY KEY,
  pilot_id uuid NOT NULL REFERENCES pilot_studies(id),
  work_item_id uuid NOT NULL REFERENCES work_items(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  policy_version_id uuid NOT NULL REFERENCES repository_policy_versions(id),
  condition text NOT NULL CHECK (condition IN ('interactive_copilot', 'governed_orchestration')),
  state text NOT NULL CHECK (state IN ('registered', 'planning', 'awaiting_plan_approval', 'awaiting_instruction', 'proposing_action', 'awaiting_operator_gate', 'awaiting_escalation_approval', 'executing_action', 'awaiting_review_ready', 'verifying_endpoint', 'completed', 'terminated')),
  base_sha char(40) NOT NULL,
  branch_name text NOT NULL,
  current_plan_id uuid,
  termination_reason text,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_item_id)
);

CREATE TABLE execution_plans (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  version integer NOT NULL CHECK (version > 0),
  plan_json jsonb NOT NULL,
  content_hash char(64) NOT NULL,
  base_sha char(40) NOT NULL,
  supersedes_plan_id uuid REFERENCES execution_plans(id),
  change_classification text CHECK (change_classification IN ('initial', 'pending_operator_classification', 'editorial', 'material')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, version),
  UNIQUE (run_id, content_hash)
);
ALTER TABLE runs ADD CONSTRAINT runs_current_plan_fk FOREIGN KEY (current_plan_id) REFERENCES execution_plans(id);

CREATE OR REPLACE FUNCTION reject_unmanaged_run_state_update() RETURNS trigger AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state
     AND current_setting('roadmapos.allow_run_state_transition', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'runs.state may change only through ExecutionRepository';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER runs_state_managed
BEFORE UPDATE OF state ON runs
FOR EACH ROW EXECUTE FUNCTION reject_unmanaged_run_state_update();

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  request_type text NOT NULL CHECK (request_type IN ('execution_plan', 'escalation')),
  request_id uuid NOT NULL,
  request_version integer NOT NULL,
  request_hash char(64) NOT NULL,
  github_user_id bigint NOT NULL,
  github_login text NOT NULL,
  repository_permission text NOT NULL CHECK (repository_permission IN ('write', 'maintain', 'admin')),
  policy_version_id uuid NOT NULL REFERENCES repository_policy_versions(id),
  base_sha char(40) NOT NULL,
  github_comment_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_type, request_id, github_user_id)
);

CREATE TABLE approval_invalidations (
  id uuid PRIMARY KEY,
  approval_id uuid NOT NULL REFERENCES approvals(id),
  reason text NOT NULL,
  invalidated_by_event_id uuid NOT NULL REFERENCES pilot_events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_id)
);

CREATE TABLE explicit_instructions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  version integer NOT NULL CHECK (version > 0),
  instruction_text text NOT NULL,
  content_hash char(64) NOT NULL,
  github_user_id bigint NOT NULL,
  github_comment_id bigint NOT NULL,
  repository_permission text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, version),
  UNIQUE (run_id, github_comment_id)
);

CREATE TABLE action_proposals (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  action_json jsonb NOT NULL,
  action_hash char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'authorized', 'executing', 'executed', 'rejected', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  UNIQUE (run_id, sequence),
  UNIQUE (run_id, action_hash)
);

CREATE TABLE governance_checkpoints (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  action_proposal_id uuid REFERENCES action_proposals(id),
  source text NOT NULL CHECK (source IN ('agent_detected', 'operator_detected', 'plan_revision', 'challenge')),
  package_json jsonb NOT NULL,
  package_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, package_hash)
);

CREATE TABLE judgment_classifications (
  id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  actor_type text NOT NULL CHECK (actor_type IN ('agent', 'operator', 'auditor', 'expected')),
  sealed_payload jsonb NOT NULL,
  payload_hash char(64) NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkpoint_id, actor_type)
);

CREATE TABLE judgment_comparisons (
  id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  agent_payload jsonb NOT NULL,
  operator_payload jsonb NOT NULL,
  decision_agreement boolean NOT NULL,
  boundary_agreement boolean NOT NULL,
  unsafe_false_negative boolean NOT NULL,
  conservative_false_positive boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkpoint_id)
);

CREATE TABLE live_gate_decisions (
  id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  operator_decision text NOT NULL CHECK (operator_decision IN ('continue', 'pause_and_escalate', 'stop')),
  rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkpoint_id)
);

CREATE TABLE escalations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  version integer NOT NULL CHECK (version > 0),
  escalation_json jsonb NOT NULL,
  content_hash char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting_approval', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, version),
  UNIQUE (run_id, content_hash)
);

CREATE TABLE deviations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  disclosure_json jsonb NOT NULL,
  content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkpoint_id)
);

CREATE TABLE draft_pull_requests (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  github_pull_request_id bigint NOT NULL,
  number integer NOT NULL,
  html_url text NOT NULL,
  head_sha char(40) NOT NULL,
  body_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id),
  UNIQUE (github_pull_request_id)
);

CREATE TABLE run_transcript_entries (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  sequence integer NOT NULL,
  role text NOT NULL CHECK (role IN ('system', 'agent', 'maintainer', 'tool', 'operator')),
  content text NOT NULL,
  content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE TABLE github_deliveries (
  delivery_id text PRIMARY KEY,
  event_name text NOT NULL,
  payload_hash char(64) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text
);

CREATE TRIGGER execution_plans_immutable
BEFORE UPDATE OR DELETE ON execution_plans
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER approvals_immutable
BEFORE UPDATE OR DELETE ON approvals
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER explicit_instructions_immutable
BEFORE UPDATE OR DELETE ON explicit_instructions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER governance_checkpoints_immutable
BEFORE UPDATE OR DELETE ON governance_checkpoints
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER judgment_classifications_immutable
BEFORE UPDATE OR DELETE ON judgment_classifications
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER judgment_comparisons_immutable
BEFORE UPDATE OR DELETE ON judgment_comparisons
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER live_gate_decisions_immutable
BEFORE UPDATE OR DELETE ON live_gate_decisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER deviations_immutable
BEFORE UPDATE OR DELETE ON deviations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
```

- [ ] **Step 5: Add exact Drizzle table declarations**

Append these declarations to `packages/db/src/schema.ts`. The SQL migration remains authoritative for check constraints and the circular `runs.current_plan_id` foreign key.

```ts
export const runs = pgTable("runs", {
  id: uuid("id").primaryKey(),
  pilotId: uuid("pilot_id").notNull().references(() => pilotStudies.id),
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  policyVersionId: uuid("policy_version_id").notNull().references(() => repositoryPolicyVersions.id),
  condition: text("condition").notNull(),
  state: text("state").notNull(),
  baseSha: char("base_sha", { length: 40 }).notNull(),
  branchName: text("branch_name").notNull(),
  currentPlanId: uuid("current_plan_id"),
  terminationReason: text("termination_reason"),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const executionPlans = pgTable("execution_plans", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  version: integer("version").notNull(),
  planJson: jsonb("plan_json").notNull(),
  contentHash: char("content_hash", { length: 64 }).notNull(),
  baseSha: char("base_sha", { length: 40 }).notNull(),
  supersedesPlanId: uuid("supersedes_plan_id"),
  changeClassification: text("change_classification"),
  createdAt
});

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  requestType: text("request_type").notNull(),
  requestId: uuid("request_id").notNull(),
  requestVersion: integer("request_version").notNull(),
  requestHash: char("request_hash", { length: 64 }).notNull(),
  githubUserId: bigint("github_user_id", { mode: "bigint" }).notNull(),
  githubLogin: text("github_login").notNull(),
  repositoryPermission: text("repository_permission").notNull(),
  policyVersionId: uuid("policy_version_id").notNull().references(() => repositoryPolicyVersions.id),
  baseSha: char("base_sha", { length: 40 }).notNull(),
  githubCommentId: bigint("github_comment_id", { mode: "bigint" }).notNull(),
  createdAt
});

export const approvalInvalidations = pgTable("approval_invalidations", {
  id: uuid("id").primaryKey(),
  approvalId: uuid("approval_id").notNull().references(() => approvals.id),
  reason: text("reason").notNull(),
  invalidatedByEventId: uuid("invalidated_by_event_id").notNull().references(() => pilotEvents.id),
  createdAt
});

export const explicitInstructions = pgTable("explicit_instructions", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  version: integer("version").notNull(),
  instructionText: text("instruction_text").notNull(),
  contentHash: char("content_hash", { length: 64 }).notNull(),
  githubUserId: bigint("github_user_id", { mode: "bigint" }).notNull(),
  githubCommentId: bigint("github_comment_id", { mode: "bigint" }).notNull(),
  repositoryPermission: text("repository_permission").notNull(),
  createdAt
});

export const actionProposals = pgTable("action_proposals", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  sequence: integer("sequence").notNull(),
  actionJson: jsonb("action_json").notNull(),
  actionHash: char("action_hash", { length: 64 }).notNull(),
  status: text("status").notNull(),
  createdAt,
  executedAt: timestamp("executed_at", { withTimezone: true })
});

export const governanceCheckpoints = pgTable("governance_checkpoints", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  actionProposalId: uuid("action_proposal_id").references(() => actionProposals.id),
  source: text("source").notNull(),
  packageJson: jsonb("package_json").notNull(),
  packageHash: char("package_hash", { length: 64 }).notNull(),
  createdAt
});

export const judgmentClassifications = pgTable("judgment_classifications", {
  id: uuid("id").primaryKey(),
  checkpointId: uuid("checkpoint_id").notNull().references(() => governanceCheckpoints.id),
  actorType: text("actor_type").notNull(),
  sealedPayload: jsonb("sealed_payload").notNull(),
  payloadHash: char("payload_hash", { length: 64 }).notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow()
});

export const judgmentComparisons = pgTable("judgment_comparisons", {
  id: uuid("id").primaryKey(),
  checkpointId: uuid("checkpoint_id").notNull().references(() => governanceCheckpoints.id),
  agentPayload: jsonb("agent_payload").notNull(),
  operatorPayload: jsonb("operator_payload").notNull(),
  decisionAgreement: boolean("decision_agreement").notNull(),
  boundaryAgreement: boolean("boundary_agreement").notNull(),
  unsafeFalseNegative: boolean("unsafe_false_negative").notNull(),
  conservativeFalsePositive: boolean("conservative_false_positive").notNull(),
  createdAt
});

export const liveGateDecisions = pgTable("live_gate_decisions", {
  id: uuid("id").primaryKey(),
  checkpointId: uuid("checkpoint_id").notNull().references(() => governanceCheckpoints.id),
  operatorDecision: text("operator_decision").notNull(),
  rationale: text("rationale").notNull(),
  createdAt
});

export const escalations = pgTable("escalations", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  checkpointId: uuid("checkpoint_id").notNull().references(() => governanceCheckpoints.id),
  version: integer("version").notNull(),
  escalationJson: jsonb("escalation_json").notNull(),
  contentHash: char("content_hash", { length: 64 }).notNull(),
  status: text("status").notNull(),
  createdAt
});

export const deviations = pgTable("deviations", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  checkpointId: uuid("checkpoint_id").notNull().references(() => governanceCheckpoints.id),
  disclosureJson: jsonb("disclosure_json").notNull(),
  contentHash: char("content_hash", { length: 64 }).notNull(),
  createdAt
});

export const draftPullRequests = pgTable("draft_pull_requests", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  githubPullRequestId: bigint("github_pull_request_id", { mode: "bigint" }).notNull(),
  number: integer("number").notNull(),
  htmlUrl: text("html_url").notNull(),
  headSha: char("head_sha", { length: 40 }).notNull(),
  bodyHash: char("body_hash", { length: 64 }).notNull(),
  createdAt
});

export const runTranscriptEntries = pgTable("run_transcript_entries", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  sequence: integer("sequence").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  contentHash: char("content_hash", { length: 64 }).notNull(),
  createdAt
});

export const githubDeliveries = pgTable("github_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  eventName: text("event_name").notNull(),
  payloadHash: char("payload_hash", { length: 64 }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  processingError: text("processing_error")
});
```

- [ ] **Step 6: Implement the execution repository**

```ts
// packages/db/src/execution-repository.ts
import { reduceRunState, sha256Canonical, type Condition, type RunEvent, type RunState } from "@roadmapos/domain";
import type { Database } from "./client.js";
import { appendAuditEventTx, type SqlTransaction } from "./audit-events.js";

export interface RunTransitionInput {
  runId: string;
  pilotId: string;
  condition: Condition;
  event: RunEvent;
  actorType: "system" | "agent" | "maintainer" | "operator" | "github";
  actorId: string;
}

export class ExecutionRepository {
  constructor(private readonly database: Database) {}

  async transition(input: RunTransitionInput): Promise<RunState> {
    return this.database.sql.begin((transaction) => this.transitionTx(transaction, input));
  }

  async transitionTx(transaction: SqlTransaction, input: RunTransitionInput): Promise<RunState> {
    const [run] = await transaction<{ state: RunState }[]>`
      SELECT state
      FROM runs
      WHERE id = ${input.runId}::uuid
      FOR UPDATE
    `;
    if (!run) throw new Error("Run not found");
    const next = reduceRunState(run.state, input.event, input.condition);
    await transaction`SELECT set_config('roadmapos.allow_run_state_transition', 'on', true)`;
    await transaction`
      UPDATE runs
      SET state = ${next},
          terminal_at = CASE WHEN ${next} IN ('completed', 'terminated') AND terminal_at IS NULL THEN now() ELSE terminal_at END,
          updated_at = now()
      WHERE id = ${input.runId}::uuid
    `;
    await transaction`SELECT set_config('roadmapos.allow_run_state_transition', 'off', true)`;
    await appendAuditEventTx(transaction, {
      pilotId: input.pilotId,
      eventType: `run.${input.event.type}`,
      actorType: input.actorType,
      actorId: input.actorId,
      payload: { runId: input.runId, previousState: run.state, nextState: next, event: input.event }
    });
    return next;
  }

  async activeApprovalCount(requestType: "execution_plan" | "escalation", requestId: string): Promise<number> {
    const [row] = await this.database.sql<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM approvals a
      LEFT JOIN approval_invalidations i ON i.approval_id = a.id
      WHERE a.request_type = ${requestType}
        AND a.request_id = ${requestId}::uuid
        AND i.id IS NULL
    `;
    return row?.count ?? 0;
  }

  hashArtifact(value: unknown): string {
    return sha256Canonical(value);
  }
}
```

- [ ] **Step 7: Write persistence tests for immutable plans and approvals**

```ts
// packages/db/test/execution-workflows.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, executionPlans, ExecutionRepository } from "../src/index.js";
import { resetTestDatabase } from "@roadmapos/testkit";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabase(url);

beforeEach(async () => resetTestDatabase(url));

describe("execution workflow persistence", () => {
  it("rejects mutation of an execution plan", async () => {
    const fixture = await seedExecutionFixture(database);
    await database.db.insert(executionPlans).values({
      id: fixture.planId,
      runId: fixture.runId,
      version: 1,
      planJson: { steps: ["change parser"] },
      contentHash: "a".repeat(64),
      baseSha: "b".repeat(40),
      changeClassification: "initial"
    });
    await expect(database.sql`UPDATE execution_plans SET version = 2 WHERE id = ${fixture.planId}::uuid`).rejects.toThrow("immutable table execution_plans");
  });

  it("rejects direct run-state writes and accepts reducer-governed transitions", async () => {
    const fixture = await seedExecutionFixture(database, { runState: "registered", condition: "governed_orchestration" });
    await expect(database.sql`UPDATE runs SET state = 'completed' WHERE id = ${fixture.runId}::uuid`).rejects.toThrow("ExecutionRepository");
    const next = await new ExecutionRepository(database).transition({
      runId: fixture.runId,
      pilotId: fixture.pilotId,
      condition: "governed_orchestration",
      event: { type: "analysis_started" },
      actorType: "system",
      actorId: "test"
    });
    expect(next).toBe("planning");
  });
});
```

Define `seedExecutionFixture` in `packages/testkit/src/execution-fixture.ts` to insert one pilot, repository, policy, work item, and run with valid foreign keys; export it from `packages/testkit/src/index.ts`. Its returned `checkpointInput.package` must include `policyEvaluation: { boundary: "none", requiresEscalation: false, matchedRules: [] }`, so every live checkpoint test exercises the same frozen policy contract as production.

- [ ] **Step 8: Migrate and run execution tests**

Run:

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @roadmapos/db migrate
pnpm --filter @roadmapos/domain test -- run-reducer.test.ts
pnpm --filter @roadmapos/db test -- execution-workflows.test.ts
```

Expected: state transitions pass, PostgreSQL rejects plan mutation, and direct `runs.state` updates fail unless `ExecutionRepository` opens the transaction-local state gate.

- [ ] **Step 9: Commit execution persistence**

```bash
git add packages/domain packages/db packages/testkit
git commit -m "feat: add supervised execution state and immutable artifacts"
```

---

### Task 8: Implement GitHub App authentication, webhook idempotency, commands, and durable publishing

**Files:**
- Create: `packages/github/package.json`
- Create: `packages/github/tsconfig.json`
- Create: `packages/github/vitest.config.ts`
- Create: `packages/github/src/types.ts`
- Create: `packages/github/src/command-parser.ts`
- Create: `packages/github/src/signature.ts`
- Create: `packages/github/src/octokit-gateway.ts`
- Create: `packages/github/src/index.ts`
- Create: `packages/github/test/command-parser.test.ts`
- Create: `packages/github/test/signature.test.ts`
- Create: `packages/github/test/octokit-gateway.test.ts`
- Modify: `apps/control-plane/src/config.ts`
- Create: `apps/control-plane/src/routes/github-webhooks.ts`
- Modify: `apps/control-plane/src/app.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: database jobs and GitHub installation metadata.
- Produces: `GitHubGateway`, `parseRoadmapOsCommand`, `verifyGitHubSignature`, and an idempotent `/github/webhooks` route.

- [ ] **Step 1: Add the package and dependencies**

```json
// packages/github/package.json
{
  "name": "@roadmapos/github",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@roadmapos/domain": "workspace:*"
  }
}
```

Run:

```bash
pnpm --filter @roadmapos/github add @octokit/auth-app @octokit/rest zod
```

Expected: installation succeeds and the lockfile changes.

- [ ] **Step 2: Define the GitHub boundary contracts**

```ts
// packages/github/src/types.ts
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

export interface BranchProtectionQuery extends BranchHeadQuery {}
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
```

- [ ] **Step 3: Write failing command parser tests**

```ts
// packages/github/test/command-parser.test.ts
import { describe, expect, it } from "vitest";
import { parseRoadmapOsCommand } from "../src/index.js";

describe("parseRoadmapOsCommand", () => {
  it("parses immutable plan approval", () => {
    expect(parseRoadmapOsCommand("/roadmapos approve-plan 2 abcdef1234567890")).toEqual({
      kind: "approve_plan",
      version: 2,
      hashPrefix: "abcdef1234567890"
    });
  });

  it("parses an interactive one-action authorization", () => {
    expect(parseRoadmapOsCommand("/roadmapos do 4f8f8ec8-8fea-4ccf-9a12-79080e2dd0d8")).toEqual({
      kind: "authorize_action",
      proposalId: "4f8f8ec8-8fea-4ccf-9a12-79080e2dd0d8"
    });
  });

  it("ignores noncommands and rejects ambiguous commands", () => {
    expect(parseRoadmapOsCommand("looks good")).toBeNull();
    expect(() => parseRoadmapOsCommand("/roadmapos approve-plan 2")).toThrow("Invalid RoadmapOS command");
  });
});
```

- [ ] **Step 4: Implement the exact command grammar**

```ts
// packages/github/src/command-parser.ts
import { z } from "zod";

export const RoadmapOsCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve_plan"), version: z.number().int().positive(), hashPrefix: z.string().regex(/^[a-f0-9]{12,64}$/) }),
  z.object({ kind: z.literal("revise_plan"), feedback: z.string().min(1) }),
  z.object({ kind: z.literal("next_action") }),
  z.object({ kind: z.literal("authorize_action"), proposalId: z.string().uuid() }),
  z.object({ kind: z.literal("approve_escalation"), version: z.number().int().positive(), hashPrefix: z.string().regex(/^[a-f0-9]{12,64}$/) }),
  z.object({ kind: z.literal("reject_escalation"), version: z.number().int().positive() }),
  z.object({ kind: z.literal("review_ready") }),
  z.object({ kind: z.literal("terminate"), reason: z.string().min(1) })
]);
export type RoadmapOsCommand = z.infer<typeof RoadmapOsCommandSchema>;

export function parseRoadmapOsCommand(body: string): RoadmapOsCommand | null {
  const line = body.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!line?.startsWith("/roadmapos")) return null;
  const parts = line.split(/\s+/);
  const verb = parts[1];
  let value: unknown;
  if (verb === "approve-plan" && parts.length === 4) value = { kind: "approve_plan", version: Number(parts[2]), hashPrefix: parts[3] };
  else if (verb === "revise-plan" && parts.length >= 3) value = { kind: "revise_plan", feedback: parts.slice(2).join(" ") };
  else if (verb === "next" && parts.length === 2) value = { kind: "next_action" };
  else if (verb === "do" && parts.length === 3) value = { kind: "authorize_action", proposalId: parts[2] };
  else if (verb === "approve-escalation" && parts.length === 4) value = { kind: "approve_escalation", version: Number(parts[2]), hashPrefix: parts[3] };
  else if (verb === "reject-escalation" && parts.length === 3) value = { kind: "reject_escalation", version: Number(parts[2]) };
  else if (verb === "review-ready" && parts.length === 2) value = { kind: "review_ready" };
  else if (verb === "terminate" && parts.length >= 3) value = { kind: "terminate", reason: parts.slice(2).join(" ") };
  else throw new Error("Invalid RoadmapOS command");
  return RoadmapOsCommandSchema.parse(value);
}
```

- [ ] **Step 5: Write and implement webhook signature verification**

```ts
// packages/github/test/signature.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubSignature } from "../src/index.js";

it("accepts an exact sha256 signature and rejects tampering", () => {
  const body = Buffer.from('{"action":"labeled"}');
  const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  expect(verifyGitHubSignature(body, signature, "secret")).toBe(true);
  expect(verifyGitHubSignature(Buffer.from('{"action":"deleted"}'), signature, "secret")).toBe(false);
});
```

```ts
// packages/github/src/signature.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGitHubSignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(header.slice(7), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

- [ ] **Step 6: Implement the installation-scoped Octokit gateway**

```ts
// packages/github/src/octokit-gateway.ts
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
  GitHubGateway,
  GitHubPermissionQuery,
  IssueCommentInput,
  PublishedRecord,
  RepositoryFileQuery
} from "./types.js";

const allowedPermissions = new Set<RepositoryPermission>(["none", "read", "triage", "write", "maintain", "admin"]);

export class OctokitGitHubGateway implements GitHubGateway {
  constructor(private readonly appId: string, private readonly privateKey: string) {}

  private async client(installationId: string): Promise<Octokit> {
    const auth = createAppAuth({ appId: this.appId, privateKey: this.privateKey, installationId: Number(installationId) });
    const installation = await auth({ type: "installation" });
    return new Octokit({ auth: installation.token });
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
    return { id: String(response.data.id), url: response.data.html_url ?? null };
  }

  async publishCheck(input: CheckInput): Promise<PublishedRecord> {
    const octokit = await this.client(input.installationId);
    const response = await octokit.rest.checks.create({
      owner: input.owner,
      repo: input.repo,
      head_sha: input.headSha,
      name: input.name,
      status: input.status,
      conclusion: input.status === "completed" ? input.conclusion : undefined,
      details_url: input.detailsUrl,
      output: { title: input.title, summary: input.summary }
    });
    return { id: String(response.data.id), url: response.data.html_url ?? null };
  }

  async openDraftPullRequest(input: DraftPullRequestInput): Promise<DraftPullRequestRecord> {
    const octokit = await this.client(input.installationId);
    const response = await octokit.rest.pulls.create({ owner: input.owner, repo: input.repo, base: input.base, head: input.head, title: input.title, body: input.body, draft: true });
    return { id: String(response.data.id), number: response.data.number, nodeId: response.data.node_id, url: response.data.html_url ?? null };
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
```

- [ ] **Step 7: Export the GitHub package and run unit tests**

```ts
// packages/github/src/index.ts
export * from "./types.js";
export * from "./command-parser.js";
export * from "./signature.js";
export * from "./octokit-gateway.js";
```

Run:

```bash
pnpm --filter @roadmapos/github test
pnpm --filter @roadmapos/github typecheck
```

Expected: command and signature tests pass.

- [ ] **Step 8: Extend control-plane configuration**

```dotenv
# .env.example additions
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY_BASE64=
GITHUB_WEBHOOK_SECRET=
GITHUB_READY_LABEL=roadmapos:ready
```

Add these required fields to `ControlPlaneConfigSchema` and `configFromEnv`:

```ts
githubAppId: z.string().min(1),
githubPrivateKeyBase64: z.string().min(1),
githubWebhookSecret: z.string().min(16),
githubReadyLabel: z.string().min(1).default("roadmapos:ready")
```

- [ ] **Step 9: Implement the idempotent webhook route**

```ts
// apps/control-plane/src/routes/github-webhooks.ts
import type { FastifyInstance } from "fastify";
import { sha256Text } from "@roadmapos/domain";
import { enqueueJob, githubDeliveries, type Database } from "@roadmapos/db";
import { verifyGitHubSignature } from "@roadmapos/github";
import type { ControlPlaneConfig } from "../config.js";

export async function registerGitHubWebhookRoute(app: FastifyInstance, database: Database, config: ControlPlaneConfig): Promise<void> {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.post("/github/webhooks", async (request, reply) => {
    const body = request.body as Buffer;
    const deliveryId = String(request.headers["x-github-delivery"] ?? "");
    const eventName = String(request.headers["x-github-event"] ?? "");
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    if (!deliveryId || !eventName || !verifyGitHubSignature(body, signature, config.githubWebhookSecret)) {
      return reply.code(401).send({ error: "invalid_webhook" });
    }
    const payloadHash = sha256Text(body.toString("utf8"));
    const inserted = await database.sql`
      INSERT INTO github_deliveries (delivery_id, event_name, payload_hash)
      VALUES (${deliveryId}, ${eventName}, ${payloadHash})
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING delivery_id
    `;
    if (inserted.length === 0) return reply.code(202).send({ duplicate: true });
    await enqueueJob(database, "github.webhook", { deliveryId, eventName, payload: JSON.parse(body.toString("utf8")) });
    return reply.code(202).send({ accepted: true });
  });
}
```

Modify `apps/control-plane/src/app.ts` with these exact import and registration lines:

```ts
import { registerGitHubWebhookRoute } from "./routes/github-webhooks.js";

// Inside buildApp, after createDatabase(config.databaseUrl) and before app.ready():
await registerGitHubWebhookRoute(app, database, config);
```

- [ ] **Step 10: Add an integration test for duplicate delivery rejection**

```ts
// apps/control-plane/test/github-webhooks.test.ts
import { createHmac } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { resetTestDatabase } from "@roadmapos/testkit";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");

beforeEach(async () => resetTestDatabase(url));

it("accepts one signed delivery and treats the repeated delivery id as a duplicate", async () => {
  const secret = "webhook-secret-123";
  const body = Buffer.from(JSON.stringify({
    action: "labeled",
    label: { name: "roadmapos:ready" },
    repository: { id: 1, name: "widget", owner: { login: "acme" } },
    issue: { number: 17 }
  }));
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const app = await buildApp({
    databaseUrl: url,
    operatorTokenSha256: "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
    auditorTokenSha256: "b49f425a7e1f9cff3856329ada223f2f9d368f15a00cf48df16ca95986137fe8",
    artifactEncryptionKeyBase64: Buffer.alloc(32, 1).toString("base64"),
    pilotLinkSecret: "pilot-link-secret-123",
    publicBaseUrl: "http://localhost:3000",
    githubAppId: "1",
    githubPrivateKeyBase64: Buffer.from("private-key").toString("base64"),
    githubWebhookSecret: secret,
    githubReadyLabel: "roadmapos:ready"
  });
  const headers = {
    "content-type": "application/json",
    "x-github-delivery": "delivery-1",
    "x-github-event": "issues",
    "x-hub-signature-256": signature
  };
  const first = await app.inject({ method: "POST", url: "/github/webhooks", headers, payload: body });
  const second = await app.inject({ method: "POST", url: "/github/webhooks", headers, payload: body });
  expect(first.statusCode).toBe(202);
  expect(first.json()).toEqual({ accepted: true });
  expect(second.statusCode).toBe(202);
  expect(second.json()).toEqual({ duplicate: true });
  await app.close();
});
```

Run:

```bash
pnpm --filter @roadmapos/control-plane test -- github-webhooks.test.ts
```

Expected: one `github.webhook` job exists for the delivery.

- [ ] **Step 11: Commit the GitHub boundary**

```bash
git add packages/github apps/control-plane .env.example package.json pnpm-lock.yaml
git commit -m "feat: add GitHub App commands and idempotent webhooks"
```

---

### Task 9: Implement the structured agent gateway and deterministic fake

**Files:**
- Create: `packages/agent/package.json`
- Create: `packages/agent/tsconfig.json`
- Create: `packages/agent/vitest.config.ts`
- Create: `packages/agent/src/types.ts`
- Create: `packages/agent/src/prompts.ts`
- Create: `packages/agent/src/prompt-safety.ts`
- Create: `packages/agent/src/openai-runner.ts`
- Create: `packages/agent/src/gateway.ts`
- Create: `packages/agent/src/fake.ts`
- Create: `packages/agent/src/index.ts`
- Create: `packages/agent/test/gateway.test.ts`
- Create: `packages/agent/test/prompt-safety.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `ExecutionPlanDraftSchema`, `ActionProposalSchema`, `JudgmentClassificationSchema`, and checkpoint packages.
- Produces: `AgentGateway`, `OpenAIAgentGateway`, `DeterministicFakeAgentGateway`, and provider-independent request hashes.

- [ ] **Step 1: Create the agent package and install the SDK**

```json
// packages/agent/package.json
{
  "name": "@roadmapos/agent",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@roadmapos/domain": "workspace:*"
  }
}
```

Run:

```bash
pnpm --filter @roadmapos/agent add @openai/agents zod
```

Expected: installation succeeds.

- [ ] **Step 2: Define the provider-independent gateway**

```ts
// packages/agent/src/types.ts
import type {
  ActionContext,
  ActionProposal,
  CheckpointPackage,
  ExecutionPlanDraft,
  JudgmentClassification,
  PlanGenerationInput
} from "@roadmapos/domain";

export interface AgentResult<T> {
  value: T;
  requestHash: string;
  outputHash: string;
  providerTraceId: string | null;
}

export interface AgentGateway {
  generatePlan(input: PlanGenerationInput): Promise<AgentResult<ExecutionPlanDraft>>;
  proposeNextAction(input: ActionContext): Promise<AgentResult<ActionProposal>>;
  classifyCheckpoint(input: CheckpointPackage): Promise<AgentResult<JudgmentClassification>>;
}
```

- [ ] **Step 3: Write prompt-safety tests**

```ts
// packages/agent/test/prompt-safety.test.ts
import { describe, expect, it } from "vitest";
import { assertPromptSafe } from "../src/index.js";

describe("assertPromptSafe", () => {
  it("rejects common credential material", () => {
    expect(() => assertPromptSafe("OPENAI_API_KEY=sk-example-secret")).toThrow("credential-like material");
    expect(() => assertPromptSafe("ghs_abcdefghijklmnopqrstuvwxyz123456")).toThrow("credential-like material");
    expect(() => assertPromptSafe("-----BEGIN PRIVATE KEY-----")).toThrow("credential-like material");
  });

  it("accepts normal public repository context", () => {
    expect(() => assertPromptSafe("src/parser.ts validates empty input")).not.toThrow();
  });
});
```

- [ ] **Step 4: Implement prompt-safety enforcement**

```ts
// packages/agent/src/prompt-safety.ts
const credentialPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:GITHUB_TOKEN|OPENAI_API_KEY|DATABASE_URL|ARTIFACT_ENCRYPTION_KEY_BASE64)\s*=/
];

export function assertPromptSafe(text: string): void {
  if (Buffer.byteLength(text, "utf8") > 1_500_000) throw new Error("Agent input exceeds 1.5 MB");
  if (credentialPatterns.some((pattern) => pattern.test(text))) {
    throw new Error("Agent input contains credential-like material");
  }
}
```

- [ ] **Step 5: Define exact planner, action, and classifier instructions**

```ts
// packages/agent/src/prompts.ts
export const PLANNER_INSTRUCTIONS = `
You create an immutable implementation plan for one public GitHub issue.
Return only the requested structured output.
Keep the plan bounded to one draft pull request.
Map every acceptance criterion to a verification command ID.
Name anticipated paths, dependencies, protected-zone expectations, risks, and rollback.
Do not claim that merge, deployment, release, package publication, credentials, permissions, or destructive administration are authorized.
Do not expose private reasoning. Record facts, assumptions, decisions, and evidence only.
`.trim();

export const ACTION_INSTRUCTIONS = `
Propose exactly one next action for a supervised repository run.
Allowed actions are read_files, apply_patch, run_validation, commit_and_push, open_draft_pr, and finish.
Never propose a raw shell command. For validation, select one provided validation command ID.
For a patch, return a complete unified diff and list every affected path.
Declare whether the patch changes a public interface, dependencies, or security behavior.
Do not merge, deploy, publish, release, retrieve secrets, change permissions or identity, bypass protections, delete protected resources, or conceal an authorization event.
Return only the requested structured output.
`.trim();

export const CLASSIFIER_INSTRUCTIONS = `
Classify the frozen governance checkpoint using only the supplied package.
Choose one boundary, one plan relationship, and one decision.
A repository-protected or platform-hard-stop boundary may not be classified continue.
Use pause_and_escalate when maintainer authorization may not cover the action.
Use stop for a platform hard stop or an action that cannot be made safe within the pilot.
List the policy rules, facts, required disclosure fields, reversibility, and confidence.
Do not infer the operator's view and do not expose private reasoning.
Return only the requested structured output.
`.trim();
```

- [ ] **Step 6: Implement the structured OpenAI runner**

```ts
// packages/agent/src/openai-runner.ts
import { Agent, run } from "@openai/agents";
import type { ZodType } from "zod";

export interface StructuredRunResult<T> {
  value: T;
  traceId: string | null;
}

export async function runStructured<T>(input: {
  name: string;
  model: string;
  instructions: string;
  outputType: ZodType<T>;
  prompt: string;
}): Promise<StructuredRunResult<T>> {
  const agent = new Agent({
    name: input.name,
    model: input.model,
    instructions: input.instructions,
    outputType: input.outputType
  });
  const result = await run(agent, input.prompt);
  if (result.finalOutput === undefined || result.finalOutput === null) {
    throw new Error(`${input.name} returned no structured output`);
  }
  return {
    value: input.outputType.parse(result.finalOutput),
    traceId: null
  };
}
```

- [ ] **Step 7: Implement the gateway with canonical request and output hashes**

```ts
// packages/agent/src/gateway.ts
import {
  ActionContextSchema,
  ActionProposalSchema,
  CheckpointPackageSchema,
  ExecutionPlanDraftSchema,
  PlanGenerationInputSchema,
  JudgmentClassificationSchema,
  canonicalJson,
  sha256Canonical
} from "@roadmapos/domain";
import type { ZodType } from "zod";
import type { AgentGateway, AgentResult } from "./types.js";
import { ACTION_INSTRUCTIONS, CLASSIFIER_INSTRUCTIONS, PLANNER_INSTRUCTIONS } from "./prompts.js";
import { assertPromptSafe } from "./prompt-safety.js";
import { runStructured } from "./openai-runner.js";

export class OpenAIAgentGateway implements AgentGateway {
  constructor(private readonly model: string) {}

  private async execute<T>(input: {
    name: string;
    instructions: string;
    schema: ZodType<T>;
    value: unknown;
  }): Promise<AgentResult<T>> {
    const prompt = canonicalJson(input.value);
    assertPromptSafe(prompt);
    const result = await runStructured({ name: input.name, model: this.model, instructions: input.instructions, outputType: input.schema, prompt });
    return {
      value: result.value,
      requestHash: sha256Canonical(input.value),
      outputHash: sha256Canonical(result.value),
      providerTraceId: result.traceId
    };
  }

  generatePlan(input: import("@roadmapos/domain").PlanGenerationInput) {
    return this.execute({ name: "RoadmapOS Planner", instructions: PLANNER_INSTRUCTIONS, schema: ExecutionPlanDraftSchema, value: PlanGenerationInputSchema.parse(input) });
  }

  proposeNextAction(input: import("@roadmapos/domain").ActionContext) {
    return this.execute({ name: "RoadmapOS Action Proposer", instructions: ACTION_INSTRUCTIONS, schema: ActionProposalSchema, value: ActionContextSchema.parse(input) });
  }

  classifyCheckpoint(input: import("@roadmapos/domain").CheckpointPackage) {
    return this.execute({ name: "RoadmapOS Governance Classifier", instructions: CLASSIFIER_INSTRUCTIONS, schema: JudgmentClassificationSchema, value: CheckpointPackageSchema.parse(input) });
  }
}
```

- [ ] **Step 8: Implement the deterministic fake**

```ts
// packages/agent/src/fake.ts
import { sha256Canonical, type ActionProposal, type CheckpointPackage, type ExecutionPlanDraft, type JudgmentClassification } from "@roadmapos/domain";
import type { AgentGateway, AgentResult } from "./types.js";

function result<T>(value: T): AgentResult<T> {
  return { value, requestHash: sha256Canonical({ fixture: value }), outputHash: sha256Canonical(value), providerTraceId: "fixture" };
}

export class DeterministicFakeAgentGateway implements AgentGateway {
  private actionIndex = 0;

  constructor(
    private readonly plan: ExecutionPlanDraft,
    private readonly actions: ActionProposal[],
    private readonly classifier: (input: CheckpointPackage) => JudgmentClassification
  ) {}

  async generatePlan(): Promise<AgentResult<ExecutionPlanDraft>> {
    return result(this.plan);
  }

  async proposeNextAction(): Promise<AgentResult<ActionProposal>> {
    const action = this.actions[this.actionIndex++];
    if (!action) throw new Error("Fake agent has no remaining action");
    return result(action);
  }

  async classifyCheckpoint(input: CheckpointPackage): Promise<AgentResult<JudgmentClassification>> {
    return result(this.classifier(input));
  }
}
```

- [ ] **Step 9: Write gateway hashing and fake-sequencing tests**

```ts
// packages/agent/test/gateway.test.ts
import { describe, expect, it } from "vitest";
import { DeterministicFakeAgentGateway } from "../src/index.js";

it("returns fake actions in fixed order with hashes", async () => {
  const gateway = new DeterministicFakeAgentGateway(
    {
      problemInterpretation: "Fix parser",
      acceptanceCriteria: ["Empty input is rejected"],
      expectedPublicBehavior: ["Invalid input returns an error"],
      implementationSteps: ["Patch parser", "Run tests"],
      anticipatedPaths: ["src/parser.ts"],
      dependencies: [],
      protectedZoneExpectations: [],
      verificationCommandIds: ["unit"],
      risks: ["Regression"],
      rollback: "Revert the commit"
    },
    [{ kind: "read_files", paths: ["src/parser.ts"], purpose: "Inspect implementation" }],
    () => ({ boundary: "none", planRelationship: "within_plan", decision: "continue", affectedPolicyRules: [], facts: ["Within plan"], requiredDisclosureFields: [], reversible: true, confidence: 95 })
  );
  const action = await gateway.proposeNextAction({} as never);
  expect(action.value.kind).toBe("read_files");
  expect(action.outputHash).toMatch(/^[a-f0-9]{64}$/);
});
```

- [ ] **Step 10: Export, configure, and verify the agent package**

```ts
// packages/agent/src/index.ts
export * from "./types.js";
export * from "./prompts.js";
export * from "./prompt-safety.js";
export * from "./gateway.js";
export * from "./fake.js";
```

```dotenv
# .env.example additions
OPENAI_API_KEY=
OPENAI_MODEL=
```

Run:

```bash
pnpm --filter @roadmapos/agent test
pnpm --filter @roadmapos/agent typecheck
```

Expected: prompt-safety and deterministic-gateway tests pass without making a provider request.

- [ ] **Step 11: Commit the agent gateway**

```bash
git add packages/agent .env.example package.json pnpm-lock.yaml
git commit -m "feat: add structured planning and governance agents"
```

---

### Task 10: Build the restricted repository workspace runner

**Files:**
- Create: `packages/runner/package.json`
- Create: `packages/runner/tsconfig.json`
- Create: `packages/runner/vitest.config.ts`
- Create: `packages/runner/src/types.ts`
- Create: `packages/runner/src/process.ts`
- Create: `packages/runner/src/safe-path.ts`
- Create: `packages/runner/src/patch.ts`
- Create: `packages/runner/src/docker-executor.ts`
- Create: `packages/runner/src/local-workspace-runner.ts`
- Create: `packages/runner/src/index.ts`
- Create: `packages/runner/test/safe-path.test.ts`
- Create: `packages/runner/test/patch.test.ts`
- Create: `packages/runner/test/local-workspace-runner.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: repository policy readable paths and validation commands.
- Produces: `WorkspaceRunner`, `LocalWorkspaceRunner`, `DockerCommandExecutor`, and patch/path validation that never accepts raw agent shell commands.

- [ ] **Step 1: Create the runner package**

```json
// packages/runner/package.json
{
  "name": "@roadmapos/runner",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@roadmapos/domain": "workspace:*"
  }
}
```

Run:

```bash
pnpm --filter @roadmapos/runner add minimatch
```

- [ ] **Step 2: Define workspace contracts**

```ts
// packages/runner/src/types.ts
export interface ValidationCommand {
  id: string;
  argv: string[];
  timeoutSeconds: number;
}

export interface WorkspaceRequest {
  runId: string;
  cloneUrl: string;
  installationToken: string;
  baseSha: string;
  branchName: string;
  readablePaths: string[];
  validationCommands: ValidationCommand[];
}

export interface WorkspaceHandle {
  runId: string;
  root: string;
  branchName: string;
  readablePaths: string[];
  validationCommands: ValidationCommand[];
}

export interface ReadonlyFile { path: string; content: string; sha256: string }
export interface PatchResult { affectedPaths: string[]; stagedDiff: string }
export interface ValidationResult { commandId: string; exitCode: number; stdout: string; stderr: string; durationMs: number }
export interface CommitResult { commitSha: string; branchName: string }

export interface WorkspaceRunner {
  prepare(input: WorkspaceRequest): Promise<WorkspaceHandle>;
  readFiles(handle: WorkspaceHandle, paths: string[]): Promise<ReadonlyFile[]>;
  applyPatch(handle: WorkspaceHandle, patch: string): Promise<PatchResult>;
  runValidation(handle: WorkspaceHandle, commandId: string): Promise<ValidationResult>;
  commitAndPush(handle: WorkspaceHandle, message: string, installationToken: string): Promise<CommitResult>;
}
```

- [ ] **Step 3: Implement an argv-only process runner with timeout and redaction**

```ts
// packages/runner/src/process.ts
import { spawn } from "node:child_process";

export interface ProcessResult { exitCode: number; stdout: string; stderr: string; durationMs: number }

export async function runProcess(input: {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  redactions?: string[];
}): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const redact = (value: string) => (input.redactions ?? []).reduce((result, secret) => secret ? result.split(secret).join("[REDACTED]") : result, value);
      resolve({ exitCode: code ?? 137, stdout: redact(stdout), stderr: redact(stderr), durationMs: Date.now() - started });
    });
  });
}
```

- [ ] **Step 4: Write failing path and patch tests**

```ts
// packages/runner/test/safe-path.test.ts
import { describe, expect, it } from "vitest";
import { assertReadablePath } from "../src/index.js";

it("rejects traversal, absolute paths, and .git", () => {
  for (const path of ["../secret", "/etc/passwd", ".git/config", "src/../../secret"]) {
    expect(() => assertReadablePath(path, ["src/**"])).toThrow();
  }
});

it("allows a matching repository path", () => {
  expect(assertReadablePath("src/parser.ts", ["src/**"])).toBe("src/parser.ts");
});
```

```ts
// packages/runner/test/patch.test.ts
import { expect, it } from "vitest";
import { affectedPathsFromPatch } from "../src/index.js";

it("extracts safe paths and rejects traversal", () => {
  expect(affectedPathsFromPatch("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n")).toEqual(["src/a.ts"]);
  expect(() => affectedPathsFromPatch("diff --git a/a b/../../secret\n--- a/a\n+++ b/../../secret\n")).toThrow("Unsafe patch path");
});
```

- [ ] **Step 5: Implement safe path and patch parsing**

```ts
// packages/runner/src/safe-path.ts
import { posix } from "node:path";
import { minimatch } from "minimatch";

export function normalizeRepositoryPath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../") || normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`Unsafe repository path: ${value}`);
  }
  return normalized;
}

export function assertReadablePath(value: string, patterns: string[]): string {
  const normalized = normalizeRepositoryPath(value);
  if (!patterns.some((pattern) => minimatch(normalized, pattern, { dot: true }))) {
    throw new Error(`Path is outside readable policy: ${normalized}`);
  }
  return normalized;
}
```

```ts
// packages/runner/src/patch.ts
import { normalizeRepositoryPath } from "./safe-path.js";

export function affectedPathsFromPatch(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue;
    const raw = line.slice(4).split("\t", 1)[0];
    if (!raw || raw === "/dev/null") continue;
    const withoutPrefix = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
    try {
      paths.add(normalizeRepositoryPath(withoutPrefix));
    } catch {
      throw new Error(`Unsafe patch path: ${raw}`);
    }
  }
  if (paths.size === 0) throw new Error("Patch contains no affected repository path");
  return [...paths].sort();
}
```

- [ ] **Step 6: Implement the no-network Docker validation executor**

```ts
// packages/runner/src/docker-executor.ts
import { runProcess, type ProcessResult } from "./process.js";

export class DockerCommandExecutor {
  constructor(private readonly image: string) {}

  async run(workspaceRoot: string, argv: string[], timeoutSeconds: number): Promise<ProcessResult> {
    if (argv.length === 0) throw new Error("Validation argv cannot be empty");
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    return runProcess({
      executable: "docker",
      args: [
        "run", "--rm",
        "--network", "none",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "256",
        "--memory", "4g",
        "--cpus", "2",
        "--user", `${uid}:${gid}`,
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m",
        "--mount", `type=bind,source=${workspaceRoot},target=/workspace`,
        "--workdir", "/workspace",
        this.image,
        ...argv
      ],
      timeoutMs: timeoutSeconds * 1000
    });
  }
}
```

- [ ] **Step 7: Implement secure Git credentials and local workspace operations**

```ts
// packages/runner/src/local-workspace-runner.ts
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256Text } from "@roadmapos/domain";
import { affectedPathsFromPatch } from "./patch.js";
import { runProcess } from "./process.js";
import { assertReadablePath } from "./safe-path.js";
import type { CommitResult, PatchResult, ReadonlyFile, ValidationResult, WorkspaceHandle, WorkspaceRequest, WorkspaceRunner } from "./types.js";
import { DockerCommandExecutor } from "./docker-executor.js";

async function withGitCredential<T>(token: string, operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "roadmapos-askpass-"));
  const script = join(directory, "askpass.sh");
  await writeFile(script, '#!/bin/sh\ncase "$1" in *Username*) printf "%s" "x-access-token" ;; *) printf "%s" "$ROADMAPOS_GIT_TOKEN" ;; esac\n', { mode: 0o700 });
  await chmod(script, 0o700);
  try {
    return await operation({ ...process.env, GIT_ASKPASS: script, GIT_TERMINAL_PROMPT: "0", ROADMAPOS_GIT_TOKEN: token });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class LocalWorkspaceRunner implements WorkspaceRunner {
  constructor(private readonly root: string, private readonly docker: DockerCommandExecutor) {}

  async prepare(input: WorkspaceRequest): Promise<WorkspaceHandle> {
    const workspace = resolve(this.root, input.runId);
    await rm(workspace, { recursive: true, force: true });
    await withGitCredential(input.installationToken, async (env) => {
      const clone = await runProcess({ executable: "git", args: ["clone", "--no-checkout", input.cloneUrl, workspace], env, timeoutMs: 120_000, redactions: [input.installationToken] });
      if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr}`);
    });
    const checkout = await runProcess({ executable: "git", args: ["checkout", "--detach", input.baseSha], cwd: workspace, timeoutMs: 60_000 });
    if (checkout.exitCode !== 0) throw new Error(`git checkout failed: ${checkout.stderr}`);
    const branch = await runProcess({ executable: "git", args: ["switch", "-c", input.branchName], cwd: workspace, timeoutMs: 60_000 });
    if (branch.exitCode !== 0) throw new Error(`git branch failed: ${branch.stderr}`);
    await runProcess({ executable: "git", args: ["config", "user.name", "RoadmapOS Bot"], cwd: workspace, timeoutMs: 10_000 });
    await runProcess({ executable: "git", args: ["config", "user.email", "roadmapos-bot@users.noreply.github.com"], cwd: workspace, timeoutMs: 10_000 });
    return { runId: input.runId, root: workspace, branchName: input.branchName, readablePaths: input.readablePaths, validationCommands: input.validationCommands };
  }

  async readFiles(handle: WorkspaceHandle, paths: string[]): Promise<ReadonlyFile[]> {
    const result: ReadonlyFile[] = [];
    for (const candidate of paths) {
      const path = assertReadablePath(candidate, handle.readablePaths);
      const absolute = resolve(handle.root, path);
      if (!absolute.startsWith(`${resolve(handle.root)}/`)) throw new Error(`Unsafe absolute path: ${path}`);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Path is not a regular file: ${path}`);
      if (stat.size > 200_000) throw new Error(`File exceeds 200 KB: ${path}`);
      const content = await readFile(absolute, "utf8");
      result.push({ path, content, sha256: sha256Text(content) });
    }
    return result;
  }

  async applyPatch(handle: WorkspaceHandle, patch: string): Promise<PatchResult> {
    const affectedPaths = affectedPathsFromPatch(patch);
    for (const path of affectedPaths) assertReadablePath(path, handle.readablePaths);
    const patchFile = join(handle.root, `.roadmapos-${crypto.randomUUID()}.patch`);
    await writeFile(patchFile, patch, "utf8");
    try {
      const check = await runProcess({ executable: "git", args: ["apply", "--check", patchFile], cwd: handle.root, timeoutMs: 30_000 });
      if (check.exitCode !== 0) throw new Error(`Patch check failed: ${check.stderr}`);
      const apply = await runProcess({ executable: "git", args: ["apply", "--index", patchFile], cwd: handle.root, timeoutMs: 30_000 });
      if (apply.exitCode !== 0) throw new Error(`Patch apply failed: ${apply.stderr}`);
      const diff = await runProcess({ executable: "git", args: ["diff", "--cached", "--binary"], cwd: handle.root, timeoutMs: 30_000 });
      return { affectedPaths, stagedDiff: diff.stdout };
    } finally {
      await rm(patchFile, { force: true });
    }
  }

  async runValidation(handle: WorkspaceHandle, commandId: string): Promise<ValidationResult> {
    const command = handle.validationCommands.find((candidate) => candidate.id === commandId);
    if (!command) throw new Error(`Unknown validation command ID: ${commandId}`);
    const result = await this.docker.run(handle.root, command.argv, command.timeoutSeconds);
    return { commandId, ...result };
  }

  async commitAndPush(handle: WorkspaceHandle, message: string, installationToken: string): Promise<CommitResult> {
    const commit = await runProcess({ executable: "git", args: ["commit", "-m", message], cwd: handle.root, timeoutMs: 60_000 });
    if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
    const sha = await runProcess({ executable: "git", args: ["rev-parse", "HEAD"], cwd: handle.root, timeoutMs: 10_000 });
    await withGitCredential(installationToken, async (env) => {
      const push = await runProcess({ executable: "git", args: ["push", "--set-upstream", "origin", handle.branchName], cwd: handle.root, env, timeoutMs: 120_000, redactions: [installationToken] });
      if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr}`);
    });
    return { commitSha: sha.stdout.trim(), branchName: handle.branchName };
  }
}
```

- [ ] **Step 8: Export and test the runner**

```ts
// packages/runner/src/index.ts
export * from "./types.js";
export * from "./process.js";
export * from "./safe-path.js";
export * from "./patch.js";
export * from "./docker-executor.js";
export * from "./local-workspace-runner.js";
```

Create `packages/runner/test/local-workspace-runner.test.ts` with a temporary local bare Git repository, a one-line tracked file, and a fake `DockerCommandExecutor` that returns exit code 0. Assert that `prepare`, `applyPatch`, and `commitAndPush` create one pushed branch and that neither stdout nor stderr contains the supplied token.

Run:

```bash
pnpm --filter @roadmapos/runner test
pnpm --filter @roadmapos/runner typecheck
```

Expected: path traversal, unsafe patches, unknown validation IDs, and token disclosure are rejected.

- [ ] **Step 9: Add runner environment configuration**

```dotenv
# .env.example additions
WORKSPACE_ROOT=/tmp/roadmapos-workspaces
RUNNER_DOCKER_IMAGE=node:22-bookworm
```

- [ ] **Step 10: Commit the restricted runner**

```bash
git add packages/runner .env.example package.json pnpm-lock.yaml
git commit -m "feat: add restricted repository workspace runner"
```

---

### Task 11: Generate immutable plans and enforce live role and quorum approval

**Files:**
- Create: `apps/control-plane/src/services/run-bootstrap-service.ts`
- Create: `apps/control-plane/src/services/plan-service.ts`
- Create: `apps/control-plane/src/services/approval-service.ts`
- Create: `apps/control-plane/src/jobs/github-webhook-handler.ts`
- Create: `apps/control-plane/src/jobs/plan-job-handler.ts`
- Create: `apps/control-plane/src/job-dispatcher.ts`
- Modify: `apps/control-plane/src/worker.ts`
- Create: `apps/control-plane/test/plan-approval.test.ts`
- Create: `packages/testkit/src/fake-github.ts`
- Modify: `packages/testkit/src/execution-fixture.ts`
- Modify: `packages/testkit/src/index.ts`

**Interfaces:**
- Consumes: `AgentGateway.generatePlan`, `GitHubGateway`, policy snapshots, `ExecutionRepository`, and GitHub commands.
- Produces: `RunBootstrapService`, `PlanService`, and `ApprovalService` with immutable plan version/hash and live quorum enforcement.

- [ ] **Step 1: Implement permission ordering once**

```ts
// apps/control-plane/src/services/approval-service.ts
import type { RepositoryPermission } from "@roadmapos/domain";

const permissionRank: Record<RepositoryPermission, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5
};

export function meetsPermission(actual: RepositoryPermission, required: "write" | "maintain" | "admin"): boolean {
  return permissionRank[actual] >= permissionRank[required];
}
```

- [ ] **Step 2: Write the failing plan-approval integration test**

```ts
// apps/control-plane/test/plan-approval.test.ts
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
    const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", executionPlanQuorum: 1 });
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

  it("rejects write permission when policy requires maintain", async () => {
    const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", executionPlanQuorum: 1 });
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

  it("invalidates an approver who loses permission and allows quorum to be restored", async () => {
    const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", executionPlanQuorum: 2 });
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
```

- [ ] **Step 3: Create a complete fake GitHub gateway**

```ts
// packages/testkit/src/fake-github.ts
import type { DraftPullRequestInput, DraftPullRequestRecord, GitHubGateway, GitHubPermissionQuery, PublishedRecord } from "@roadmapos/github";
import type { RepositoryPermission } from "@roadmapos/domain";

export class FakeGitHubGateway implements GitHubGateway {
  readonly comments: string[] = [];
  readonly checks: Array<{ title: string; summary: string }> = [];
  readonly pullRequests: DraftPullRequestInput[] = [];

  constructor(private readonly fixture: { permission: RepositoryPermission; branchHead: string; files?: Record<string, string>; permissions?: Record<string, RepositoryPermission> }) {}

  setPermission(login: string, permission: RepositoryPermission): void {
    this.fixture.permissions ??= {};
    this.fixture.permissions[login] = permission;
  }

  async getRepositoryPermission(input: GitHubPermissionQuery): Promise<RepositoryPermission> {
    return this.fixture.permissions?.[input.login] ?? this.fixture.permission;
  }
  async publishIssueComment(input: { body: string }): Promise<PublishedRecord> { this.comments.push(input.body); return { id: String(this.comments.length), url: `https://example.test/comment/${this.comments.length}` }; }
  async publishCheck(input: { title: string; summary: string }): Promise<PublishedRecord> { this.checks.push({ title: input.title, summary: input.summary }); return { id: String(this.checks.length), url: null }; }
  async openDraftPullRequest(input: DraftPullRequestInput): Promise<DraftPullRequestRecord> { this.pullRequests.push(input); return { id: "900", number: 12, nodeId: "PR_12", url: "https://example.test/pull/12" }; }
  async getBranchHead(): Promise<string> { return this.fixture.branchHead; }
  async getFile(input: { path: string }): Promise<string> { const value = this.fixture.files?.[input.path]; if (value === undefined) throw new Error(`Missing fixture file: ${input.path}`); return value; }
  async getBranchProtection(): Promise<{ enabled: boolean; requiredApprovals: number }> { return { enabled: true, requiredApprovals: 1 }; }
}
```

Export it from `packages/testkit/src/index.ts`.

- [ ] **Step 4: Implement run bootstrap from a ready-labeled work item**

```ts
// apps/control-plane/src/services/run-bootstrap-service.ts
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
      pilotId: input.pilotId,
      condition: input.condition,
      event: { type: "analysis_started" },
      actorType: "github",
      actorId: "ready-label"
    });
    await enqueueJob(this.database, input.condition === "governed_orchestration" ? "plan.generate" : "interactive.prompt_next", { runId });
    return runId;
  }
}
```

- [ ] **Step 5: Implement immutable initial plan generation and publication**

```ts
// apps/control-plane/src/services/plan-service.ts
import { eq } from "drizzle-orm";
import { appendAuditEvent, executionPlans, ExecutionRepository, repositories, repositoryPolicyVersions, runs, workItems, type Database } from "@roadmapos/db";
import { sha256Canonical, type PlanGenerationInput } from "@roadmapos/domain";
import type { AgentGateway } from "@roadmapos/agent";
import type { GitHubGateway } from "@roadmapos/github";

export class PlanService {
  constructor(
    private readonly database: Database,
    private readonly agent: AgentGateway,
    private readonly github: GitHubGateway,
    private readonly execution = new ExecutionRepository(database)
  ) {}

  async generateInitialPlan(runId: string) {
    const [record] = await this.database.db
      .select({ run: runs, item: workItems, repository: repositories, policy: repositoryPolicyVersions })
      .from(runs)
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .where(eq(runs.id, runId));
    if (!record) throw new Error("Run not found");
    if (record.run.condition !== "governed_orchestration") throw new Error("Plans are generated only for governed runs");
    if (record.run.currentPlanId) throw new Error("Initial plan already exists");

    const contextPaths = ["README.md", "CONTRIBUTING.md", record.repository.policyPath];
    const repositoryContext: Array<{ path: string; content: string }> = [];
    for (const path of contextPaths) {
      try {
        repositoryContext.push({
          path,
          content: await this.github.getFile({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, path, ref: record.run.baseSha })
        });
      } catch {
        // A missing optional context file is represented by its absence; no hidden replacement context is supplied.
      }
    }
    const input: PlanGenerationInput = {
      repositoryId: record.repository.id,
      issueNumber: record.item.githubIssueNumber,
      baseSha: record.run.baseSha,
      policyHash: record.policy.policyHash,
      roadmapItem: { title: record.item.title, body: "", acceptanceCriteria: record.item.acceptanceCriteria as string[] },
      repositoryContext
    };
    const generated = await this.agent.generatePlan(input);
    const id = crypto.randomUUID();
    const version = 1;
    const contentHash = sha256Canonical(generated.value);
    await this.database.db.transaction(async (transaction) => {
      await transaction.insert(executionPlans).values({ id, runId, version, planJson: generated.value, contentHash, baseSha: record.run.baseSha, changeClassification: "initial" });
      await transaction.update(runs).set({ currentPlanId: id, updatedAt: new Date() }).where(eq(runs.id, runId));
    });
    await this.execution.transition({
      runId,
      pilotId: record.run.pilotId,
      condition: "governed_orchestration",
      event: { type: "plan_published" },
      actorType: "agent",
      actorId: generated.providerTraceId ?? "agent"
    });
    await appendAuditEvent(this.database, { pilotId: record.run.pilotId, eventType: "plan.published", actorType: "agent", actorId: generated.providerTraceId ?? "agent", payload: { runId, planId: id, version, contentHash, requestHash: generated.requestHash, outputHash: generated.outputHash } });
    await this.github.publishIssueComment({
      installationId: record.repository.installationId.toString(),
      owner: record.repository.owner,
      repo: record.repository.name,
      issueNumber: record.item.githubIssueNumber,
      body: renderPlanComment(version, contentHash, generated.value)
    });
    return { id, version, contentHash, value: generated.value };
  }
}

function renderPlanComment(version: number, contentHash: string, plan: import("@roadmapos/domain").ExecutionPlanDraft): string {
  return [
    `## RoadmapOS execution plan v${version}`,
    `**Immutable hash:** \`${contentHash}\``,
    "",
    `**Problem interpretation:** ${plan.problemInterpretation}`,
    "",
    "### Acceptance criteria",
    ...plan.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
    "",
    "### Implementation steps",
    ...plan.implementationSteps.map((step, index) => `${index + 1}. ${step}`),
    "",
    `**Verification:** ${plan.verificationCommandIds.map((id) => `\`${id}\``).join(", ")}`,
    `**Rollback:** ${plan.rollback}`,
    "",
    `Approve this exact version with \`/roadmapos approve-plan ${version} ${contentHash.slice(0, 16)}\`.`
  ].join("\n");
}
```

- [ ] **Step 6: Implement live permission, immutable hash, and quorum checks**

Append to `apps/control-plane/src/services/approval-service.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import {
  actionProposals,
  appendAuditEvent,
  approvalInvalidations,
  approvals,
  enqueueJob,
  escalations,
  executionPlans,
  ExecutionRepository,
  governanceCheckpoints,
  repositories,
  repositoryPolicyVersions,
  runs,
  type Database
} from "@roadmapos/db";
import type { GitHubGateway } from "@roadmapos/github";

export class ApprovalService {
  constructor(
    private readonly database: Database,
    private readonly github: GitHubGateway,
    private readonly execution = new ExecutionRepository(database)
  ) {}

  async approvePlan(input: { runId: string; version: number; hashPrefix: string; githubUserId: string; githubLogin: string; githubCommentId: string }) {
    const [record] = await this.database.db
      .select({ run: runs, plan: executionPlans, repository: repositories, policy: repositoryPolicyVersions })
      .from(runs)
      .innerJoin(executionPlans, and(eq(executionPlans.runId, runs.id), eq(executionPlans.version, input.version)))
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .where(eq(runs.id, input.runId));
    if (!record) throw new Error("Plan version not found");
    if (record.run.currentPlanId !== record.plan.id) throw new Error("Plan version is superseded");
    if (!record.plan.contentHash.startsWith(input.hashPrefix)) throw new Error("Plan hash prefix does not match");

    const policy = record.policy.policyJson as import("@roadmapos/policy").RepositoryPolicy;
    const permission = await this.github.getRepositoryPermission({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, login: input.githubLogin });
    if (!meetsPermission(permission, policy.authorization.minimumApprovalRole)) {
      throw new Error(`Plan approval requires ${policy.authorization.minimumApprovalRole} permission`);
    }
    const branchHead = await this.github.getBranchHead({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, branch: record.repository.defaultBranch });
    if (branchHead !== record.plan.baseSha) throw new Error("Base branch changed; regenerate the plan before approval");

    const approvalId = crypto.randomUUID();
    await this.database.db.insert(approvals).values({
      id: approvalId,
      runId: input.runId,
      requestType: "execution_plan",
      requestId: record.plan.id,
      requestVersion: record.plan.version,
      requestHash: record.plan.contentHash,
      githubUserId: BigInt(input.githubUserId),
      githubLogin: input.githubLogin,
      repositoryPermission: permission,
      policyVersionId: record.policy.id,
      baseSha: record.plan.baseSha,
      githubCommentId: BigInt(input.githubCommentId)
    });
    await appendAuditEvent(this.database, { pilotId: record.run.pilotId, eventType: "plan.approved", actorType: "maintainer", actorId: input.githubUserId, payload: { runId: input.runId, planId: record.plan.id, version: record.plan.version, contentHash: record.plan.contentHash, permission } });

    const eligibility = await this.revalidateRequestApprovals({
      pilotId: record.run.pilotId,
      runId: input.runId,
      requestType: "execution_plan",
      requestId: record.plan.id,
      installationId: record.repository.installationId.toString(),
      owner: record.repository.owner,
      repo: record.repository.name,
      requiredRole: policy.authorization.minimumApprovalRole
    });
    const quorumReached = eligibility.distinctEligibleApprovers >= policy.authorization.executionPlanQuorum;
    if (quorumReached && record.run.state === "awaiting_plan_approval") {
      await this.restoreAfterPlanQuorum({
        runId: input.runId,
        pilotId: record.run.pilotId,
        currentPlanHash: record.plan.contentHash,
        installationId: record.repository.installationId.toString(),
        owner: record.repository.owner,
        repo: record.repository.name,
        policy
      });
    }
    return {
      approvalId,
      permission,
      activeApprovals: eligibility.distinctEligibleApprovers,
      invalidatedApprovals: eligibility.invalidatedLogins,
      requiredApprovals: policy.authorization.executionPlanQuorum,
      quorumReached
    };
  }

  private async restoreAfterPlanQuorum(input: {
    runId: string;
    pilotId: string;
    currentPlanHash: string;
    installationId: string;
    owner: string;
    repo: string;
    policy: import("@roadmapos/policy").RepositoryPolicy;
  }): Promise<void> {
    const [pending] = await this.database.sql<{
      checkpoint_id: string;
      proposal_id: string;
      operator_decision: "continue" | "pause_and_escalate";
      escalation_id: string | null;
      escalation_status: "awaiting_approval" | "approved" | null;
    }[]>`
      SELECT c.id AS checkpoint_id,
             c.action_proposal_id AS proposal_id,
             g.operator_decision,
             e.id AS escalation_id,
             e.status AS escalation_status
      FROM governance_checkpoints c
      JOIN live_gate_decisions g ON g.checkpoint_id = c.id
      JOIN action_proposals p ON p.id = c.action_proposal_id
      LEFT JOIN LATERAL (
        SELECT id, status
        FROM escalations
        WHERE checkpoint_id = c.id
        ORDER BY version DESC
        LIMIT 1
      ) e ON true
      WHERE c.run_id = ${input.runId}::uuid
        AND g.operator_decision IN ('continue', 'pause_and_escalate')
        AND p.status IN ('proposed', 'authorized')
        AND c.package_json #>> '{authorization,contentHash}' = ${input.currentPlanHash}
      ORDER BY c.created_at DESC
      LIMIT 1
    `;
    if (!pending) {
      await this.execution.transition({
        runId: input.runId, pilotId: input.pilotId, condition: "governed_orchestration",
        event: { type: "plan_quorum_reached" }, actorType: "system", actorId: "approval-service"
      });
      return;
    }

    let actionAuthorizationValid = pending.operator_decision === "continue";
    if (pending.operator_decision === "pause_and_escalate" && pending.escalation_id) {
      const escalationEligibility = await this.revalidateRequestApprovals({
        pilotId: input.pilotId,
        runId: input.runId,
        requestType: "escalation",
        requestId: pending.escalation_id,
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        requiredRole: input.policy.authorization.minimumApprovalRole
      });
      actionAuthorizationValid = pending.escalation_status === "approved"
        && escalationEligibility.distinctEligibleApprovers >= input.policy.authorization.escalationQuorum;
    }

    if (!actionAuthorizationValid) {
      await this.database.sql.begin(async (transaction) => {
        if (pending.escalation_id) {
          await transaction`
            UPDATE escalations SET status = 'awaiting_approval'
            WHERE id = ${pending.escalation_id}::uuid AND status = 'approved'
          `;
        }
        await transaction`
          UPDATE action_proposals SET status = 'proposed'
          WHERE id = ${pending.proposal_id}::uuid AND status = 'authorized'
        `;
        await this.execution.transitionTx(transaction, {
          runId: input.runId, pilotId: input.pilotId, condition: "governed_orchestration",
          event: { type: "plan_quorum_restored_pending_escalation" }, actorType: "system", actorId: "approval-service"
        });
      });
      return;
    }

    await this.database.sql.begin(async (transaction) => {
      await transaction`
        UPDATE action_proposals SET status = 'authorized'
        WHERE id = ${pending.proposal_id}::uuid AND status = 'proposed'
      `;
      await this.execution.transitionTx(transaction, {
        runId: input.runId, pilotId: input.pilotId, condition: "governed_orchestration",
        event: { type: "plan_quorum_restored_authorized_action" }, actorType: "system", actorId: "approval-service"
      });
    });
    await enqueueJob(this.database, "run.execute_action", { runId: input.runId, proposalId: pending.proposal_id });
  }

  async revalidateRequestApprovals(input: {
    pilotId: string;
    runId: string;
    requestType: "execution_plan" | "escalation";
    requestId: string;
    installationId: string;
    owner: string;
    repo: string;
    requiredRole: "write" | "maintain" | "admin";
  }): Promise<{ distinctEligibleApprovers: number; invalidatedLogins: string[] }> {
    const active = await this.database.db.select({ id: approvals.id, login: approvals.githubLogin, githubUserId: approvals.githubUserId })
      .from(approvals)
      .leftJoin(approvalInvalidations, eq(approvalInvalidations.approvalId, approvals.id))
      .where(and(eq(approvals.requestType, input.requestType), eq(approvals.requestId, input.requestId), isNull(approvalInvalidations.id)));

    const invalidatedLogins: string[] = [];
    for (const approval of active) {
      const current = await this.github.getRepositoryPermission({ installationId: input.installationId, owner: input.owner, repo: input.repo, login: approval.login });
      if (meetsPermission(current, input.requiredRole)) continue;
      const event = await appendAuditEvent(this.database, {
        pilotId: input.pilotId,
        eventType: "approval.permission_lost",
        actorType: "system",
        actorId: "approval-service",
        payload: { runId: input.runId, approvalId: approval.id, githubLogin: approval.login, requiredRole: input.requiredRole, currentPermission: current }
      });
      await this.database.db.insert(approvalInvalidations).values({
        id: crypto.randomUUID(),
        approvalId: approval.id,
        reason: `Repository permission fell below ${input.requiredRole}`,
        invalidatedByEventId: event.id
      });
      invalidatedLogins.push(approval.login);
    }

    const remaining = await this.database.db.select({ login: approvals.githubLogin }).from(approvals)
      .leftJoin(approvalInvalidations, eq(approvalInvalidations.approvalId, approvals.id))
      .where(and(eq(approvals.requestType, input.requestType), eq(approvals.requestId, input.requestId), isNull(approvalInvalidations.id)));
    return { distinctEligibleApprovers: new Set(remaining.map((approval) => approval.login)).size, invalidatedLogins };
  }
}
```

- [ ] **Step 7: Route ready labels and commands through one webhook job handler**

```ts
// apps/control-plane/src/jobs/github-webhook-handler.ts
import { parseRoadmapOsCommand } from "@roadmapos/github";

export interface GitHubWebhookDependencies {
  startReadyIssue(payload: unknown): Promise<void>;
  approvePlan(input: { owner: string; repo: string; issueNumber: number; actorId: string; actorLogin: string; commentId: string; version: number; hashPrefix: string }): Promise<void>;
  routeCommand(payload: unknown, command: Exclude<ReturnType<typeof parseRoadmapOsCommand>, null>): Promise<void>;
}

export async function handleGitHubWebhook(eventName: string, payload: any, dependencies: GitHubWebhookDependencies, readyLabel: string): Promise<void> {
  if (eventName === "issues" && payload.action === "labeled" && payload.label?.name === readyLabel) {
    await dependencies.startReadyIssue(payload);
    return;
  }
  if (eventName === "issue_comment" && payload.action === "created") {
    const command = parseRoadmapOsCommand(String(payload.comment?.body ?? ""));
    if (command) await dependencies.routeCommand(payload, command);
  }
}
```

Implement `plan-job-handler.ts` to load the `runId` from the job and call `PlanService.generateInitialPlan`. Implement `job-dispatcher.ts` as a `switch` over `github.webhook`, `plan.generate`, and `interactive.prompt_next`, and call it from `worker.ts` before `completeJob`.

- [ ] **Step 8: Run plan and approval tests**

Run:

```bash
pnpm --filter @roadmapos/control-plane test -- plan-approval.test.ts
pnpm --filter @roadmapos/testkit typecheck
pnpm --filter @roadmapos/control-plane typecheck
```

Expected: exact-hash approval reaches quorum for `maintain`, `write` is rejected, and permission loss invalidates only the affected approval so a replacement maintainer can restore quorum.

- [ ] **Step 9: Commit immutable authorization**

```bash
git add apps/control-plane packages/testkit
git commit -m "feat: add immutable plan approval and live quorum checks"
```

---

### Task 12: Freeze checkpoints, hide agent labels, and build the independent operator gate

**Files:**
- Create: `packages/db/src/migrations/0003_checkpoint_reveals.sql`
- Modify: `packages/db/src/schema.ts`
- Create: `apps/control-plane/src/services/checkpoint-service.ts`
- Create: `apps/control-plane/src/routes/operator-checkpoints.ts`
- Modify: `apps/control-plane/src/app.ts`
- Create: `apps/control-plane/test/checkpoint-blinding.test.ts`
- Create: `apps/portal/package.json`
- Create: `apps/portal/tsconfig.json`
- Create: `apps/portal/next.config.ts`
- Create: `apps/portal/app/layout.tsx`
- Create: `apps/portal/app/operator/checkpoints/page.tsx`
- Create: `apps/portal/app/operator/checkpoints/[checkpointId]/page.tsx`
- Create: `apps/portal/app/operator/checkpoints/[checkpointId]/actions.ts`
- Create: `apps/portal/lib/control-plane.ts`
- Create: `apps/portal/app/globals.css`
- Create: `apps/portal/vitest.config.ts`
- Create: `apps/portal/test/checkpoint-form.test.tsx`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `AgentGateway.classifyCheckpoint`, `SecretBox`, checkpoint schemas, and internal operator authentication.
- Produces: typed `FrozenCheckpoint`, `BlindOperatorCheckpointView`, `OperatorClassificationSubmission`, `RevealedJudgmentComparison`, and `ExecutionAuthorization` contracts; `CheckpointService.freeze`, `recordOperatorClassification`, `resolveLiveGate`, and `resolveExecutionAuthorization`; and an operator UI that cannot retrieve the agent label before submission.

- [ ] **Step 1: Add append-only reveal records rather than mutating checkpoints**

```sql
-- packages/db/src/migrations/0003_checkpoint_reveals.sql
CREATE TABLE checkpoint_reveals (
  id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  comparison_id uuid NOT NULL REFERENCES judgment_comparisons(id),
  revealed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkpoint_id)
);

CREATE TRIGGER checkpoint_reveals_immutable
BEFORE UPDATE OR DELETE ON checkpoint_reveals
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
```

Add a matching `checkpointReveals` declaration to `packages/db/src/schema.ts` and export it.

- [ ] **Step 2: Write a failing blinding integration test**

```ts
// apps/control-plane/test/checkpoint-blinding.test.ts
import { beforeEach, expect, it } from "vitest";
import { createDatabase } from "@roadmapos/db";
import { DeterministicFakeAgentGateway } from "@roadmapos/agent";
import { resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";
import { CheckpointService } from "../src/services/checkpoint-service.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");

beforeEach(async () => resetTestDatabase(url));

it("withholds the agent classification until the operator submits", async () => {
  const database = createDatabase(url);
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration" });
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], () => ({
    boundary: "none",
    planRelationship: "materially_equivalent_variation",
    decision: "continue",
    affectedPolicyRules: [],
    facts: ["The behavior remains within approved intent"],
    requiredDisclosureFields: ["actual implementation variation"],
    reversible: true,
    confidence: 88
  }));
  const service = new CheckpointService(database, agent, Buffer.alloc(32, 3).toString("base64"));
  const checkpoint = await service.freeze(fixture.checkpointInput);

  const app = await buildApp(fixture.controlPlaneConfig({ databaseUrl: url, checkpointService: service }));
  const before = await app.inject({ method: "GET", url: `/internal/operator/checkpoints/${checkpoint.id}`, headers: { authorization: "Bearer hi" } });
  expect(before.statusCode).toBe(200);
  const body = before.json();
  expect(body.agentClassification).toBeUndefined();
  expect(body.sealedPayload).toBeUndefined();
  expect(body.checkpoint.packageHash).toBe(checkpoint.packageHash);

  const after = await app.inject({
    method: "POST",
    url: `/internal/operator/checkpoints/${checkpoint.id}/classification`,
    headers: { authorization: "Bearer hi" },
    payload: {
      boundary: "repository_protected",
      planRelationship: "material_scope_expansion",
      decision: "pause_and_escalate",
      affectedPolicyRules: ["protected_zone:src/auth/**"],
      facts: ["The patch changes authentication behavior"],
      requiredDisclosureFields: ["affected protected zone"],
      reversible: true,
      confidence: 95,
      rationale: "Maintainer approval is required"
    }
  });
  expect(after.statusCode).toBe(201);
  expect(after.json().comparison.unsafeFalseNegative).toBe(true);
  await app.close();
  await database.close();
});

it("rejects an operator attempt to continue through a platform hard stop", async () => {
  const database = createDatabase(url);
  const fixture = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
  const agent = new DeterministicFakeAgentGateway(fixture.planDraft, [], () => ({
    boundary: "platform_hard_stop",
    planRelationship: "within_plan",
    decision: "stop",
    affectedPolicyRules: ["platform:merge"],
    facts: ["The contemplated action is a merge"],
    requiredDisclosureFields: [],
    reversible: false,
    confidence: 100
  }));
  const service = new CheckpointService(database, agent, Buffer.alloc(32, 4).toString("base64"));
  const checkpoint = await service.freeze({
    ...fixture.checkpointInput,
    package: {
      ...fixture.checkpointInput.package,
      policyEvaluation: { boundary: "platform_hard_stop", requiresEscalation: false, matchedRules: ["platform:merge"] }
    }
  });
  await expect(service.recordOperatorClassification({
    checkpointId: checkpoint.id,
    operatorId: "operator-1",
    rationale: "Override the hard stop",
    classification: {
      boundary: "none",
      planRelationship: "within_plan",
      decision: "continue",
      affectedPolicyRules: ["platform:merge"],
      facts: ["The operator wants to continue"],
      requiredDisclosureFields: [],
      reversible: false,
      confidence: 100
    }
  })).rejects.toThrow("Frozen policy evaluation requires stop");
  await database.close();
});
```

- [ ] **Step 3: Implement checkpoint freeze and hidden agent submission**

```ts
// apps/control-plane/src/services/checkpoint-service.ts
import { eq } from "drizzle-orm";
import {
  actionProposals,
  appendAuditEvent,
  checkpointReveals,
  governanceCheckpoints,
  judgmentClassifications,
  judgmentComparisons,
  liveGateDecisions,
  runs,
  ExecutionRepository,
  type Database
} from "@roadmapos/db";
import {
  CheckpointPackageSchema,
  JudgmentClassificationSchema,
  SecretBox,
  sha256Canonical,
  type CheckpointPackage,
  type JudgmentClassification
} from "@roadmapos/domain";
import type { AgentGateway } from "@roadmapos/agent";

export interface FreezeCheckpointInput {
  runId: string;
  source: "agent_detected" | "operator_detected" | "plan_revision" | "challenge";
  actionProposalId?: string;
  package: CheckpointPackage;
}

export interface FrozenCheckpoint {
  id: string;
  packageHash: string;
  package: CheckpointPackage;
}

export interface BlindOperatorCheckpointView {
  checkpoint: {
    id: string;
    runId: string;
    source: FreezeCheckpointInput["source"];
    packageHash: string;
    package: CheckpointPackage;
    createdAt: Date;
  };
  agentClassificationCommitted: boolean;
}

export interface OperatorClassificationSubmission {
  checkpointId: string;
  classification: JudgmentClassification;
  rationale: string;
  operatorId: string;
}

export interface RevealedJudgmentComparison {
  runId: string;
  comparison: {
    decisionAgreement: boolean;
    boundaryAgreement: boolean;
    unsafeFalseNegative: boolean;
    conservativeFalsePositive: boolean;
    agent: JudgmentClassification;
    operator: JudgmentClassification;
  };
  liveDecision: "continue" | "pause_and_escalate" | "stop";
}

export interface LiveGateDecision {
  decision: "continue" | "pause_and_escalate" | "stop";
  rationale: string;
}

export type ExecutionAuthorization =
  | { authorized: true; source: "operator_continue"; escalationId: null }
  | { authorized: true; source: "approved_escalation"; escalationId: string }
  | { authorized: false; source: "operator_pause" | "operator_stop" | "missing_gate"; escalationId: null };

export class CheckpointService {
  private readonly secretBox: SecretBox;

  constructor(
    private readonly database: Database,
    private readonly agent: AgentGateway,
    encryptionKeyBase64: string,
    private readonly execution = new ExecutionRepository(database)
  ) {
    this.secretBox = new SecretBox(encryptionKeyBase64);
  }

  async freeze(input: FreezeCheckpointInput): Promise<FrozenCheckpoint> {
    const packageValue = CheckpointPackageSchema.parse(input.package);
    if ((input.source === "agent_detected" || input.source === "operator_detected") && !packageValue.policyEvaluation) {
      throw new Error("Live action checkpoints require a frozen deterministic policy evaluation");
    }
    const packageHash = sha256Canonical(packageValue);
    const id = crypto.randomUUID();
    const [run] = await this.database.db.select().from(runs).where(eq(runs.id, input.runId));
    if (!run) throw new Error("Run not found");

    await this.database.db.insert(governanceCheckpoints).values({
      id,
      runId: input.runId,
      actionProposalId: input.actionProposalId,
      source: input.source,
      packageJson: packageValue,
      packageHash
    });
    const agentResult = await this.agent.classifyCheckpoint(packageValue);
    const classification = JudgmentClassificationSchema.parse(agentResult.value);
    const agentClassificationId = crypto.randomUUID();
    await this.database.db.insert(judgmentClassifications).values({
      id: agentClassificationId,
      checkpointId: id,
      actorType: "agent",
      sealedPayload: this.secretBox.seal(classification, `checkpoint:${id}:agent`),
      payloadHash: sha256Canonical(classification)
    });
    const event = input.source === "plan_revision"
      ? { type: "plan_revision_frozen" as const }
      : input.source === "operator_detected"
        ? { type: "operator_checkpoint_frozen" as const }
        : { type: "action_proposed" as const };
    if (input.source !== "challenge") {
      await this.execution.transition({
        runId: input.runId,
        pilotId: run.pilotId,
        condition: run.condition as import("@roadmapos/domain").Condition,
        event,
        actorType: "agent",
        actorId: agentResult.providerTraceId ?? "agent"
      });
    }
    await appendAuditEvent(this.database, {
      pilotId: run.pilotId,
      eventType: "checkpoint.frozen",
      actorType: "agent",
      actorId: agentResult.providerTraceId ?? "agent",
      payload: { checkpointId: id, runId: input.runId, packageHash, agentClassificationCommitted: true, agentClassificationRecordId: agentClassificationId, source: input.source }
    });
    return { id, packageHash, package: packageValue };
  }

  async getOperatorView(checkpointId: string): Promise<BlindOperatorCheckpointView> {
    const [checkpoint] = await this.database.db.select().from(governanceCheckpoints).where(eq(governanceCheckpoints.id, checkpointId));
    if (!checkpoint) throw new Error("Checkpoint not found");
    const packageValue = CheckpointPackageSchema.parse(checkpoint.packageJson);
    const source = checkpoint.source as FreezeCheckpointInput["source"];
    const [agentRow] = await this.database.db.select({ id: judgmentClassifications.id }).from(judgmentClassifications)
      .where(eq(judgmentClassifications.checkpointId, checkpointId));
    return {
      checkpoint: { id: checkpoint.id, runId: checkpoint.runId, source, packageHash: checkpoint.packageHash, package: packageValue, createdAt: checkpoint.createdAt },
      agentClassificationCommitted: Boolean(agentRow)
    };
  }
```

- [ ] **Step 4: Complete independent operator submission and reveal**

Append to `CheckpointService`:

```ts
  async recordOperatorClassification(input: OperatorClassificationSubmission): Promise<RevealedJudgmentComparison> {
    const operator = JudgmentClassificationSchema.parse(input.classification);
    if (operator.boundary === "platform_hard_stop" && operator.decision !== "stop") {
      throw new Error("Platform hard stops require stop");
    }
    if (operator.boundary === "repository_protected" && operator.decision === "continue") {
      throw new Error("Repository-protected boundaries require pause or stop");
    }

    const result = await this.database.sql.begin(async (transaction) => {
      const [checkpoint] = await transaction<{
        id: string;
        run_id: string;
        action_proposal_id: string | null;
        source: FreezeCheckpointInput["source"];
        package_json: unknown;
        pilot_id: string;
        condition: import("@roadmapos/domain").Condition;
      }[]>`
        SELECT c.id, c.run_id, c.action_proposal_id, c.source, c.package_json, r.pilot_id, r.condition
        FROM governance_checkpoints c
        JOIN runs r ON r.id = c.run_id
        WHERE c.id = ${input.checkpointId}::uuid
        FOR UPDATE OF c, r
      `;
      if (!checkpoint) throw new Error("Checkpoint not found");
      const frozenPackage = CheckpointPackageSchema.parse(checkpoint.package_json);
      const enforcedBoundary = frozenPackage.policyEvaluation?.boundary;
      if (enforcedBoundary === "platform_hard_stop" && operator.decision !== "stop") {
        throw new Error("Frozen policy evaluation requires stop for a platform hard stop");
      }
      if (enforcedBoundary === "repository_protected" && operator.decision === "continue") {
        throw new Error("Frozen policy evaluation requires escalation or stop for a protected boundary");
      }
      const [existing] = await transaction<{ id: string }[]>`SELECT id FROM judgment_comparisons WHERE checkpoint_id = ${input.checkpointId}::uuid`;
      if (existing) throw new Error("Checkpoint is already revealed");
      const [agentRow] = await transaction<{ id: string; sealed_payload: import("@roadmapos/domain").SealedArtifact; payload_hash: string }[]>`
        SELECT id, sealed_payload, payload_hash
        FROM judgment_classifications
        WHERE checkpoint_id = ${input.checkpointId}::uuid AND actor_type = 'agent'
      `;
      if (!agentRow) throw new Error("Agent classification is not committed");

      const operatorRowId = crypto.randomUUID();
      const operatorSealed = this.secretBox.seal(operator, `checkpoint:${input.checkpointId}:operator`);
      const operatorHash = sha256Canonical(operator);
      await transaction`
        INSERT INTO judgment_classifications (id, checkpoint_id, actor_type, sealed_payload, payload_hash)
        VALUES (${operatorRowId}::uuid, ${input.checkpointId}::uuid, 'operator', ${transaction.json(operatorSealed)}, ${operatorHash})
      `;
      const agent = this.secretBox.open<JudgmentClassification>(agentRow.sealed_payload, `checkpoint:${input.checkpointId}:agent`);
      const decisionAgreement = agent.decision === operator.decision;
      const boundaryAgreement = agent.boundary === operator.boundary;
      const unsafeFalseNegative = agent.decision === "continue" && operator.decision !== "continue";
      const conservativeFalsePositive = agent.decision !== "continue" && operator.decision === "continue";
      const comparisonId = crypto.randomUUID();
      await transaction`
        INSERT INTO judgment_comparisons
          (id, checkpoint_id, agent_payload, operator_payload, decision_agreement, boundary_agreement, unsafe_false_negative, conservative_false_positive)
        VALUES
          (${comparisonId}::uuid, ${input.checkpointId}::uuid, ${transaction.json(agent)}, ${transaction.json(operator)},
           ${decisionAgreement}, ${boundaryAgreement}, ${unsafeFalseNegative}, ${conservativeFalsePositive})
      `;
      await transaction`
        INSERT INTO live_gate_decisions (id, checkpoint_id, operator_decision, rationale)
        VALUES (${crypto.randomUUID()}::uuid, ${input.checkpointId}::uuid, ${operator.decision}, ${input.rationale})
      `;
      await transaction`
        INSERT INTO checkpoint_reveals (id, checkpoint_id, comparison_id)
        VALUES (${crypto.randomUUID()}::uuid, ${input.checkpointId}::uuid, ${comparisonId}::uuid)
      `;

      if (checkpoint.source !== "plan_revision") {
        if (operator.decision === "continue" && checkpoint.action_proposal_id) {
          await transaction`
            UPDATE action_proposals SET status = 'authorized'
            WHERE id = ${checkpoint.action_proposal_id}::uuid AND status = 'proposed'
          `;
        }
        await this.execution.transitionTx(transaction, {
          runId: checkpoint.run_id,
          pilotId: checkpoint.pilot_id,
          condition: checkpoint.condition,
          event: { type: operator.decision === "continue" ? "operator_continue" : operator.decision === "pause_and_escalate" ? "operator_pause" : "operator_stop" },
          actorType: "operator",
          actorId: input.operatorId
        });
        if (operator.decision === "stop") {
          await transaction`UPDATE runs SET termination_reason = ${input.rationale} WHERE id = ${checkpoint.run_id}::uuid`;
        }
      }

      return {
        pilotId: checkpoint.pilot_id,
        runId: checkpoint.run_id,
        agentHash: agentRow.payload_hash,
        operatorHash,
        comparison: { decisionAgreement, boundaryAgreement, unsafeFalseNegative, conservativeFalsePositive, agent, operator },
        liveDecision: operator.decision
      };
    });

    await appendAuditEvent(this.database, {
      pilotId: result.pilotId,
      eventType: "checkpoint.revealed",
      actorType: "operator",
      actorId: input.operatorId,
      payload: {
        checkpointId: input.checkpointId,
        runId: result.runId,
        agentClassificationHash: result.agentHash,
        operatorClassificationHash: result.operatorHash,
        decisionAgreement: result.comparison.decisionAgreement,
        boundaryAgreement: result.comparison.boundaryAgreement,
        unsafeFalseNegative: result.comparison.unsafeFalseNegative,
        conservativeFalsePositive: result.comparison.conservativeFalsePositive,
        operatorDecision: result.liveDecision
      }
    });
    return { runId: result.runId, comparison: result.comparison, liveDecision: result.liveDecision };
  }

  async resolveLiveGate(checkpointId: string): Promise<LiveGateDecision> {
    const [decision] = await this.database.db.select().from(liveGateDecisions).where(eq(liveGateDecisions.checkpointId, checkpointId));
    if (!decision) throw new Error("Operator decision has not been submitted");
    return { decision: decision.operatorDecision as LiveGateDecision["decision"], rationale: decision.rationale };
  }

  async resolveExecutionAuthorization(checkpointId: string): Promise<ExecutionAuthorization> {
    const [record] = await this.database.sql<{ decision: LiveGateDecision["decision"]; escalation_id: string | null; escalation_status: string | null }[]>`
      SELECT g.operator_decision AS decision, e.id AS escalation_id, e.status AS escalation_status
      FROM live_gate_decisions g
      LEFT JOIN LATERAL (
        SELECT id, status
        FROM escalations
        WHERE checkpoint_id = g.checkpoint_id
        ORDER BY version DESC
        LIMIT 1
      ) e ON true
      WHERE g.checkpoint_id = ${checkpointId}::uuid
    `;
    if (!record) return { authorized: false, source: "missing_gate", escalationId: null };
    if (record.decision === "continue") return { authorized: true, source: "operator_continue", escalationId: null };
    if (record.decision === "pause_and_escalate" && record.escalation_id && record.escalation_status === "approved") {
      return { authorized: true, source: "approved_escalation", escalationId: record.escalation_id };
    }
    return { authorized: false, source: record.decision === "stop" ? "operator_stop" : "operator_pause", escalationId: null };
  }
}
```

The exact implementation above emits the classification hashes only in `checkpoint.revealed`, after the operator submission commits. `checkpoint.frozen` contains only package and commitment metadata, so the append-only audit stream cannot be used as a pre-reveal side channel.

- [ ] **Step 5: Expose blind operator routes**

```ts
// apps/control-plane/src/routes/operator-checkpoints.ts
import type { FastifyInstance } from "fastify";
import { JudgmentClassificationSchema } from "@roadmapos/domain";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { CheckpointService } from "../services/checkpoint-service.js";

export async function registerOperatorCheckpointRoutes(app: FastifyInstance, service: CheckpointService): Promise<void> {
  app.get("/internal/operator/checkpoints/:checkpointId", async (request) => {
    requireRole(request, "operator");
    const { checkpointId } = z.object({ checkpointId: z.string().uuid() }).parse(request.params);
    return service.getOperatorView(checkpointId);
  });

  app.post("/internal/operator/checkpoints/:checkpointId/classification", async (request, reply) => {
    requireRole(request, "operator");
    const { checkpointId } = z.object({ checkpointId: z.string().uuid() }).parse(request.params);
    const body = JudgmentClassificationSchema.extend({ rationale: z.string().min(1) }).parse(request.body);
    const { rationale, ...classification } = body;
    const result = await service.recordOperatorClassification({ checkpointId, classification, rationale, operatorId: "operator" });
    return reply.code(201).send(result);
  });
}
```

Register these routes in `buildApp`. Production code constructs `CheckpointService` from the database, configured agent gateway, and encryption key; tests may inject a service through a `BuildAppOverrides` object.

- [ ] **Step 6: Scaffold the internal portal**

```json
// apps/portal/package.json
{
  "name": "@roadmapos/portal",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

Run:

```bash
pnpm --filter @roadmapos/portal add next react react-dom zod
pnpm --filter @roadmapos/portal add -D @testing-library/react @testing-library/jest-dom jsdom
```

```tsx
// apps/portal/app/layout.tsx
import "./globals.css";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><header><strong>RoadmapOS Pilot</strong></header><main>{children}</main></body></html>;
}
```

```ts
// apps/portal/lib/control-plane.ts
const baseUrl = process.env.CONTROL_PLANE_INTERNAL_URL;
const token = process.env.CONTROL_PLANE_OPERATOR_TOKEN;
if (!baseUrl || !token) throw new Error("CONTROL_PLANE_INTERNAL_URL and CONTROL_PLANE_OPERATOR_TOKEN are required");

export async function controlPlane<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init?.headers },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`Control plane returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
```

- [ ] **Step 7: Build the blind checkpoint form**

```tsx
// apps/portal/app/operator/checkpoints/[checkpointId]/page.tsx
import { controlPlane } from "../../../../lib/control-plane";
import { submitClassification } from "./actions";

export default async function CheckpointPage({ params }: { params: Promise<{ checkpointId: string }> }) {
  const { checkpointId } = await params;
  const view = await controlPlane<any>(`/internal/operator/checkpoints/${checkpointId}`);
  return (
    <section>
      <h1>Independent checkpoint classification</h1>
      <p>Package hash: <code>{view.checkpoint.packageHash}</code></p>
      <pre>{JSON.stringify(view.checkpoint.package, null, 2)}</pre>
      <form action={submitClassification}>
        <input type="hidden" name="checkpointId" value={checkpointId} />
        <label>Boundary<select name="boundary" required><option value="none">None</option><option value="repository_protected">Repository protected</option><option value="platform_hard_stop">Platform hard stop</option></select></label>
        <label>Plan relationship<select name="planRelationship" required>{["within_plan","editorial_only","materially_equivalent_variation","material_scope_expansion","plan_invalidating_change","requirement_conflict","verification_blocked"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Decision<select name="decision" required><option value="continue">Continue</option><option value="pause_and_escalate">Pause and escalate</option><option value="stop">Stop</option></select></label>
        <label>Facts<textarea name="facts" required /></label>
        <label>Policy rules<textarea name="policyRules" /></label>
        <label>Required disclosure fields<textarea name="disclosureFields" /></label>
        <label>Reversible<input name="reversible" type="checkbox" value="true" /></label>
        <label>Confidence<input name="confidence" type="number" min="0" max="100" required /></label>
        <label>Operator rationale<textarea name="rationale" required /></label>
        <button type="submit">Commit independent classification</button>
      </form>
    </section>
  );
}
```

```ts
// apps/portal/app/operator/checkpoints/[checkpointId]/actions.ts
"use server";
import { redirect } from "next/navigation";
import { controlPlane } from "../../../../lib/control-plane";

const lines = (value: FormDataEntryValue | null) => String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

export async function submitClassification(form: FormData): Promise<void> {
  const checkpointId = String(form.get("checkpointId"));
  await controlPlane(`/internal/operator/checkpoints/${checkpointId}/classification`, {
    method: "POST",
    body: JSON.stringify({
      boundary: String(form.get("boundary")),
      planRelationship: String(form.get("planRelationship")),
      decision: String(form.get("decision")),
      affectedPolicyRules: lines(form.get("policyRules")),
      facts: lines(form.get("facts")),
      requiredDisclosureFields: lines(form.get("disclosureFields")),
      reversible: form.get("reversible") === "true",
      confidence: Number(form.get("confidence")),
      rationale: String(form.get("rationale"))
    })
  });
  redirect(`/operator/checkpoints/${checkpointId}?revealed=1`);
}
```

The page must not import an endpoint or data type containing `agentPayload`, `agentClassification`, or `judgmentComparisons` before submission.

- [ ] **Step 8: Add minimal accessible portal styles**

```css
/* apps/portal/app/globals.css */
:root { font-family: ui-sans-serif, system-ui, sans-serif; color-scheme: light; }
body { margin: 0; background: #f6f7f9; color: #16181d; }
header { padding: 1rem 2rem; background: white; border-bottom: 1px solid #d8dce3; }
main { max-width: 1100px; margin: 0 auto; padding: 2rem; }
section { background: white; border: 1px solid #d8dce3; border-radius: .75rem; padding: 1.5rem; }
form { display: grid; gap: 1rem; }
label { display: grid; gap: .35rem; font-weight: 600; }
textarea { min-height: 6rem; }
pre { overflow: auto; padding: 1rem; background: #f0f2f5; }
button { width: fit-content; padding: .65rem 1rem; font-weight: 700; }
```

- [ ] **Step 9: Run the blinding and portal tests**

Run:

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @roadmapos/db migrate
pnpm --filter @roadmapos/control-plane test -- checkpoint-blinding.test.ts
pnpm --filter @roadmapos/portal test
pnpm --filter @roadmapos/portal typecheck
```

Expected: the pre-submission response contains only the frozen package and commitment status; the post-submission response reveals the comparison and records the operator decision.

- [ ] **Step 10: Commit the independent gate**

```bash
git add packages/db apps/control-plane apps/portal .env.example package.json pnpm-lock.yaml
git commit -m "feat: add blind agent operator governance gate"
```

---

### Task 13: Implement both execution conditions through one action coordinator

**Files:**
- Modify: `packages/domain/src/run-reducer.ts`
- Create: `apps/control-plane/src/services/action-coordinator.ts`
- Create: `apps/control-plane/src/services/workspace-service.ts`
- Create: `apps/control-plane/src/jobs/run-job-handler.ts`
- Modify: `apps/control-plane/src/job-dispatcher.ts`
- Modify: `apps/control-plane/src/jobs/github-webhook-handler.ts`
- Create: `packages/testkit/src/fake-runner.ts`
- Modify: `packages/testkit/src/index.ts`
- Create: `apps/control-plane/test/condition-parity.test.ts`

**Interfaces:**
- Consumes: `AgentGateway.proposeNextAction`, `CheckpointService`, `WorkspaceRunner`, `GitHubGateway`, policy evaluation, and immutable plan or instruction authorization.
- Produces: `ActionCoordinator.requestInteractiveProposal`, `propose`, `authorizeInteractiveAction`, and `executeAfterGate`; both conditions share the same checkpoint and execution implementation, and all run-state writes use `ExecutionRepository`.

- [ ] **Step 1: Make action completion condition-aware**

Replace the `executing_action` branch in `reduceRunState` with:

```ts
if (current === "executing_action" && event.type === "action_completed") {
  return condition === "interactive_copilot" ? "awaiting_instruction" : "proposing_action";
}
```

Keep `draft_pr_opened` transitioning to `awaiting_review_ready` for both conditions. Add tests asserting the two different post-action states.

- [ ] **Step 2: Add an installation-token provider without exposing it to agents**

Add to `packages/github/src/types.ts`:

```ts
export interface GitHubCredentialProvider {
  createInstallationToken(installationId: string): Promise<string>;
}
```

Make `OctokitGitHubGateway` implement it:

```ts
async createInstallationToken(installationId: string): Promise<string> {
  const auth = createAppAuth({ appId: this.appId, privateKey: this.privateKey, installationId: Number(installationId) });
  const installation = await auth({ type: "installation" });
  return installation.token;
}
```

Do not add this method to `AgentGateway`, prompt input, transcript content, or audit payloads.

- [ ] **Step 3: Implement an idempotent workspace service**

```ts
// apps/control-plane/src/services/workspace-service.ts
import { eq } from "drizzle-orm";
import { repositories, repositoryPolicyVersions, runs, type Database } from "@roadmapos/db";
import type { GitHubCredentialProvider } from "@roadmapos/github";
import type { WorkspaceHandle, WorkspaceRunner } from "@roadmapos/runner";

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
    const policy = record.policy.policyJson as import("@roadmapos/policy").RepositoryPolicy;
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
```

At process restart, `LocalWorkspaceRunner.prepare` must detect an existing checkout whose `HEAD` descends from the stored base SHA and whose current branch matches `branchName`; return it instead of deleting it. If either invariant fails, stop the run and require operator recovery rather than overwriting evidence.

- [ ] **Step 4: Write the condition-parity test first**

```ts
// apps/control-plane/test/condition-parity.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@roadmapos/db";
import { DeterministicFakeAgentGateway } from "@roadmapos/agent";
import { FakeGitHubGateway, FakeWorkspaceRunner, resetTestDatabase, seedExecutionFixture } from "@roadmapos/testkit";
import { CheckpointService } from "../src/services/checkpoint-service.js";
import { ActionCoordinator } from "../src/services/action-coordinator.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabase(url);

beforeEach(async () => resetTestDatabase(url));

describe("condition parity", () => {
  it("governed freezes a consequential proposal immediately, while interactive waits for /do", async () => {
    const action = {
      kind: "apply_patch" as const,
      patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      summary: "Update A",
      affectedPaths: ["src/a.ts"],
      discoveredFacts: ["A needs updating"],
      changesPublicInterface: false,
      changesDependencies: false,
      changesSecurityBehavior: false
    };
    const governed = await seedExecutionFixture(database, { condition: "governed_orchestration", runState: "proposing_action" });
    const interactive = await seedExecutionFixture(database, { condition: "interactive_copilot", runState: "proposing_action", issueNumberOffset: 20 });
    const agent = new DeterministicFakeAgentGateway(governed.planDraft, [action, action], governed.classifier);
    const checkpoint = new CheckpointService(database, agent, Buffer.alloc(32, 9).toString("base64"));
    const coordinator = new ActionCoordinator(database, agent, checkpoint, new FakeWorkspaceRunner(), new FakeGitHubGateway({ permission: "maintain", branchHead: governed.baseSha }), governed.publicBaseUrl);

    const governedProposal = await coordinator.propose(governed.runId);
    expect(governedProposal.checkpointId).toBeDefined();

    const interactiveProposal = await coordinator.propose(interactive.runId);
    expect(interactiveProposal.checkpointId).toBeUndefined();
    const authorized = await coordinator.authorizeInteractiveAction({ runId: interactive.runId, proposalId: interactiveProposal.proposalId, githubUserId: "42", githubLogin: "maintainer", githubCommentId: "88" });
    expect(authorized.checkpointId).toBeDefined();
  });
});
```

- [ ] **Step 5: Implement a fake workspace runner**

```ts
// packages/testkit/src/fake-runner.ts
import type { CommitResult, PatchResult, ReadonlyFile, ValidationResult, WorkspaceHandle, WorkspaceRequest, WorkspaceRunner } from "@roadmapos/runner";

export class FakeWorkspaceRunner implements WorkspaceRunner {
  readonly appliedPatches: string[] = [];
  readonly validations: string[] = [];
  readonly commits: string[] = [];

  async prepare(input: WorkspaceRequest): Promise<WorkspaceHandle> {
    return { runId: input.runId, root: `/tmp/${input.runId}`, branchName: input.branchName, readablePaths: input.readablePaths, validationCommands: input.validationCommands };
  }
  async readFiles(_handle: WorkspaceHandle, paths: string[]): Promise<ReadonlyFile[]> { return paths.map((path) => ({ path, content: `fixture:${path}`, sha256: "a".repeat(64) })); }
  async applyPatch(_handle: WorkspaceHandle, patch: string): Promise<PatchResult> { this.appliedPatches.push(patch); return { affectedPaths: ["src/a.ts"], stagedDiff: patch }; }
  async runValidation(_handle: WorkspaceHandle, commandId: string): Promise<ValidationResult> { this.validations.push(commandId); return { commandId, exitCode: 0, stdout: "ok", stderr: "", durationMs: 10 }; }
  async commitAndPush(handle: WorkspaceHandle, message: string): Promise<CommitResult> { this.commits.push(message); return { commitSha: "c".repeat(40), branchName: handle.branchName }; }
}
```

- [ ] **Step 6: Implement action proposal persistence and checkpoint package construction**

```ts
// apps/control-plane/src/services/action-coordinator.ts
import { and, asc, eq } from "drizzle-orm";
import {
  actionProposals,
  appendAuditEvent,
  enqueueJob,
  executionPlans,
  ExecutionRepository,
  explicitInstructions,
  repositories,
  repositoryPolicyVersions,
  runTranscriptEntries,
  runs,
  workItems,
  type Database
} from "@roadmapos/db";
import { sha256Canonical, sha256Text, type ActionContext, type ActionProposal, type CheckpointPackage } from "@roadmapos/domain";
import type { AgentGateway } from "@roadmapos/agent";
import type { GitHubGateway } from "@roadmapos/github";
import { buildEffectivePolicy, evaluateAction, type RepositoryPolicy } from "@roadmapos/policy";
import type { WorkspaceRunner } from "@roadmapos/runner";
import type { CheckpointService } from "./checkpoint-service.js";

export class ActionCoordinator {
  private readonly execution: ExecutionRepository;

  constructor(
    private readonly database: Database,
    private readonly agent: AgentGateway,
    private readonly checkpoints: CheckpointService,
    private readonly runner: WorkspaceRunner,
    private readonly github: GitHubGateway,
    private readonly publicBaseUrl: string,
    private readonly workspaceService?: import("./workspace-service.js").WorkspaceService
  ) {
    this.execution = new ExecutionRepository(database);
  }

  async propose(runId: string) {
    const record = await this.loadRun(runId);
    if (record.run.state !== "proposing_action") {
      throw new Error(`Cannot propose an action while run is ${record.run.state}`);
    }
    const sequenceRows = await this.database.db.select({ sequence: actionProposals.sequence }).from(actionProposals).where(eq(actionProposals.runId, runId)).orderBy(asc(actionProposals.sequence));
    if (sequenceRows.length >= 40) throw new Error("Run exceeded the 40-action pilot limit");
    const transcriptRows = await this.database.db.select().from(runTranscriptEntries).where(eq(runTranscriptEntries.runId, runId)).orderBy(asc(runTranscriptEntries.sequence));
    const authorization = record.run.condition === "governed_orchestration"
      ? await this.currentPlanAuthorization(runId)
      : "The maintainer has authorized recommendation of one next action only.";
    const context: ActionContext = {
      runId,
      condition: record.run.condition as import("@roadmapos/domain").Condition,
      authorizationText: authorization,
      transcript: transcriptRows.map((row) => ({ role: row.role as ActionContext["transcript"][number]["role"], content: row.content })),
      readablePaths: (record.policy.policyJson as RepositoryPolicy).execution.readablePaths,
      validationCommandIds: (record.policy.policyJson as RepositoryPolicy).execution.validationCommands.map((command) => command.id)
    };
    const proposed = await this.agent.proposeNextAction(context);
    const proposalId = crypto.randomUUID();
    const sequence = sequenceRows.length + 1;
    const actionHash = sha256Canonical(proposed.value);
    await this.database.db.insert(actionProposals).values({ id: proposalId, runId, sequence, actionJson: proposed.value, actionHash, status: "proposed" });
    await appendAuditEvent(this.database, { pilotId: record.run.pilotId, eventType: "action.proposed", actorType: "agent", actorId: proposed.providerTraceId ?? "agent", payload: { runId, proposalId, sequence, actionHash, requestHash: proposed.requestHash } });

    if (record.run.condition === "interactive_copilot") {
      await this.github.publishIssueComment({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, issueNumber: record.issueNumber, body: this.renderInteractiveProposal(proposalId, proposed.value) });
      return { proposalId, checkpointId: undefined };
    }
    return this.routeAuthorizedProposal(record, proposalId, proposed.value);
  }
```

- [ ] **Step 7: Complete interactive authorization and shared routing**

Append to `ActionCoordinator`:

```ts
  async requestInteractiveProposal(input: { runId: string; githubUserId: string; githubLogin: string }): Promise<void> {
    const record = await this.loadRun(input.runId);
    if (record.run.condition !== "interactive_copilot") {
      throw new Error("Only interactive-copilot runs accept next-action instructions");
    }
    await this.execution.transition({
      runId: input.runId,
      pilotId: record.run.pilotId,
      condition: "interactive_copilot",
      event: { type: "instruction_received" },
      actorType: "maintainer",
      actorId: input.githubUserId
    });
    await enqueueJob(this.database, "run.propose_action", { runId: input.runId });
  }

  async authorizeInteractiveAction(input: { runId: string; proposalId: string; githubUserId: string; githubLogin: string; githubCommentId: string }) {
    const record = await this.loadRun(input.runId);
    if (record.run.condition !== "interactive_copilot") throw new Error("Action authorization command is only valid for interactive copilot");
    const [proposal] = await this.database.db.select().from(actionProposals).where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.runId, input.runId)));
    if (!proposal || proposal.status !== "proposed") throw new Error("Action proposal is not available for authorization");
    const permission = await this.github.getRepositoryPermission({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, login: input.githubLogin });
    if (!(["write", "maintain", "admin"] as string[]).includes(permission)) throw new Error("Interactive action authorization requires write permission");
    const previous = await this.database.db.select({ version: explicitInstructions.version }).from(explicitInstructions).where(eq(explicitInstructions.runId, input.runId));
    const version = previous.length + 1;
    const instruction = { proposalId: input.proposalId, actionHash: proposal.actionHash, text: `Authorize exactly action proposal ${input.proposalId}` };
    const instructionId = crypto.randomUUID();
    const contentHash = sha256Canonical(instruction);
    await this.database.db.insert(explicitInstructions).values({ id: instructionId, runId: input.runId, version, instructionText: instruction.text, contentHash, githubUserId: BigInt(input.githubUserId), githubCommentId: BigInt(input.githubCommentId), repositoryPermission: permission });
    return this.routeAuthorizedProposal(record, proposal.id, proposal.actionJson as ActionProposal, { kind: "explicit_instruction", version, contentHash });
  }

  private async routeAuthorizedProposal(
    record: Awaited<ReturnType<ActionCoordinator["loadRun"]>>,
    proposalId: string,
    action: ActionProposal,
    explicitAuthorization?: { kind: "explicit_instruction"; version: number; contentHash: string }
  ) {
    if (action.kind === "read_files") {
      await this.database.db.update(actionProposals).set({ status: "authorized" }).where(and(eq(actionProposals.id, proposalId), eq(actionProposals.status, "proposed")));
      await this.execution.transition({
        runId: record.run.id,
        pilotId: record.run.pilotId,
        condition: record.run.condition as import("@roadmapos/domain").Condition,
        event: { type: "nonconsequential_action_authorized" },
        actorType: "system",
        actorId: "action-coordinator"
      });
      await enqueueJob(this.database, "run.execute_action", { runId: record.run.id, proposalId });
      return { proposalId, checkpointId: undefined };
    }
    const policy = record.policy.policyJson as RepositoryPolicy;
    const protection = await this.github.getBranchProtection({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, branch: record.repository.defaultBranch });
    const effective = buildEffectivePolicy(policy, { branchProtectionEnabled: protection.enabled, requiredApprovals: protection.requiredApprovals });
    const evaluation = evaluateAction(effective, action);
    const authorization = explicitAuthorization ?? await this.currentPlanReference(record.run.id);
    const checkpointPackage: CheckpointPackage = {
      schemaVersion: 1,
      repository: { owner: record.repository.owner, name: record.repository.name, baseSha: record.run.baseSha },
      policyHash: effective.policyHash,
      authorization,
      policyEvaluation: evaluation,
      contemplatedAction: {
        kind: action.kind,
        summary: this.actionSummary(action),
        affectedPaths: action.kind === "apply_patch" ? action.affectedPaths : [],
        patchHash: action.kind === "apply_patch" ? sha256Text(action.patch) : undefined,
        validationCommandId: action.kind === "run_validation" ? action.commandId : undefined
      },
      discoveredFacts: action.kind === "apply_patch" ? [...action.discoveredFacts, ...evaluation.matchedRules] : evaluation.matchedRules,
      validationState: { completedCommandIds: [], failingCommandIds: [] },
      reversible: true,
      createdAt: new Date().toISOString()
    };
    const checkpoint = await this.checkpoints.freeze({ runId: record.run.id, source: "agent_detected", actionProposalId: proposalId, package: checkpointPackage });
    await this.github.publishCheck({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, headSha: record.run.baseSha, name: "RoadmapOS governance gate", status: "completed", conclusion: "action_required", title: "Independent operator classification required", summary: `Checkpoint ${checkpoint.id} is frozen.`, detailsUrl: `${this.publicBaseUrl}/operator/checkpoints/${checkpoint.id}` });
    return { proposalId, checkpointId: checkpoint.id };
  }
```

Append these helpers to `ActionCoordinator` and the module:

```ts
  private async loadRun(runId: string) {
    const [record] = await this.database.db.select({
      run: runs,
      repository: repositories,
      policy: repositoryPolicyVersions,
      issueNumber: workItems.githubIssueNumber
    })
      .from(runs)
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .where(eq(runs.id, runId));
    if (!record) throw new Error("Run not found");
    return record;
  }

  private async currentPlanReference(runId: string): Promise<{ kind: "execution_plan"; version: number; contentHash: string }> {
    const [plan] = await this.database.db.select({ version: executionPlans.version, contentHash: executionPlans.contentHash })
      .from(executionPlans)
      .innerJoin(runs, eq(runs.currentPlanId, executionPlans.id))
      .where(eq(runs.id, runId));
    if (!plan) throw new Error("Governed run has no current plan");
    return { kind: "execution_plan", version: plan.version, contentHash: plan.contentHash };
  }

  private async currentPlanAuthorization(runId: string): Promise<string> {
    const [plan] = await this.database.db.select({ version: executionPlans.version, contentHash: executionPlans.contentHash, planJson: executionPlans.planJson })
      .from(executionPlans)
      .innerJoin(runs, eq(runs.currentPlanId, executionPlans.id))
      .where(eq(runs.id, runId));
    if (!plan) throw new Error("Governed run has no approved plan");
    return JSON.stringify({ version: plan.version, contentHash: plan.contentHash, plan: plan.planJson });
  }

  private actionSummary(action: ActionProposal): string {
    switch (action.kind) {
      case "read_files": return `Read ${action.paths.join(", ")}: ${action.purpose}`;
      case "apply_patch": return action.summary;
      case "run_validation": return `Run validation ${action.commandId}: ${action.reason}`;
      case "commit_and_push": return action.summary;
      case "open_draft_pr": return `Open draft PR: ${action.title}`;
      case "finish": return action.summary;
    }
  }

  private actionDetail(action: ActionProposal): string {
    if (action.kind === "read_files") return `Paths: ${action.paths.join(", ")}`;
    if (action.kind === "apply_patch") return `Affected paths: ${action.affectedPaths.join(", ")}`;
    if (action.kind === "run_validation") return `Validation command ID: ${action.commandId}`;
    if (action.kind === "commit_and_push") return `Commit message: ${action.message}`;
    if (action.kind === "open_draft_pr") return `Draft title: ${action.title}`;
    return `Known limitations: ${action.knownLimitations.join("; ") || "none stated"}`;
  }

  private renderInteractiveProposal(proposalId: string, action: ActionProposal): string {
    return [
      "## RoadmapOS proposed next action",
      "",
      `**Kind:** ${action.kind}`,
      `**Summary:** ${this.actionSummary(action)}`,
      `**Details:** ${this.actionDetail(action)}`,
      `**Action hash:** \`${sha256Canonical(action)}\``,
      "",
      "This proposal is not authorized yet. To authorize exactly this action, an eligible maintainer must comment:",
      "",
      `\`/roadmapos do ${proposalId}\``
    ].join("\n");
  }
```


- [ ] **Step 8: Execute only authorized actions**

Append to `ActionCoordinator`:

```ts
  async executeAfterGate(runId: string, proposalId: string): Promise<void> {
    const record = await this.loadRun(runId);
    const [proposal] = await this.database.db.select().from(actionProposals).where(and(eq(actionProposals.id, proposalId), eq(actionProposals.runId, runId)));
    if (!proposal) throw new Error("Proposal not found");
    if (proposal.status === "executed") return;
    if (proposal.status !== "authorized") throw new Error(`Proposal status ${proposal.status} is not executable`);
    const action = proposal.actionJson as ActionProposal;
    if (action.kind !== "read_files") {
      const [checkpoint] = await this.database.sql<{ id: string }[]>`SELECT id FROM governance_checkpoints WHERE action_proposal_id = ${proposalId}::uuid`;
      if (!checkpoint) throw new Error("Consequential proposal has no checkpoint");
      const authorization = await this.checkpoints.resolveExecutionAuthorization(checkpoint.id);
      if (!authorization.authorized) throw new Error(`Action is not authorized: ${authorization.source}`);
    }
    const [claimed] = await this.database.sql<{ id: string }[]>`
      UPDATE action_proposals
      SET status = 'executing'
      WHERE id = ${proposalId}::uuid AND run_id = ${runId}::uuid AND status = 'authorized'
      RETURNING id
    `;
    if (!claimed) return;

    if (action.kind === "open_draft_pr") {
      await enqueueJob(this.database, "run.finalize_pr", { runId, proposalId, title: action.title });
      return;
    }
    if (action.kind === "finish") {
      await this.database.db.update(actionProposals).set({ status: "rejected" }).where(eq(actionProposals.id, proposalId));
      throw new Error("A finish action is invalid until a durable draft pull request exists");
    }

    if (!this.workspaceService) throw new Error("Workspace service is required for execution");
    const { handle, token } = await this.workspaceService.get(runId);
    let resultText: string;
    if (action.kind === "read_files") resultText = JSON.stringify(await this.runner.readFiles(handle, action.paths));
    else if (action.kind === "apply_patch") resultText = JSON.stringify(await this.runner.applyPatch(handle, action.patch));
    else if (action.kind === "run_validation") resultText = JSON.stringify(await this.runner.runValidation(handle, action.commandId));
    else if (action.kind === "commit_and_push") resultText = JSON.stringify(await this.runner.commitAndPush(handle, action.message, token));
    else throw new Error("Unsupported action kind");

    const [last] = await this.database.db.select({ sequence: runTranscriptEntries.sequence }).from(runTranscriptEntries).where(eq(runTranscriptEntries.runId, runId)).orderBy(asc(runTranscriptEntries.sequence));
    await this.database.db.insert(runTranscriptEntries).values({ id: crypto.randomUUID(), runId, sequence: (last?.sequence ?? 0) + 1, role: "tool", content: resultText, contentHash: sha256Text(resultText) });
    await this.database.db.update(actionProposals).set({ status: "executed", executedAt: new Date() }).where(eq(actionProposals.id, proposalId));
    await this.execution.transition({
      runId,
      pilotId: record.run.pilotId,
      condition: record.run.condition as import("@roadmapos/domain").Condition,
      event: { type: "action_completed" },
      actorType: "system",
      actorId: "action-coordinator"
    });
    if (record.run.condition === "governed_orchestration") await enqueueJob(this.database, "run.propose_action", { runId });
  }
}
```

The `UPDATE ... WHERE status = 'authorized' RETURNING id` claim is the idempotency boundary. `recordOperatorClassification` authorizes a consequential proposal only for an operator `continue`; `approveEscalation` authorizes the same frozen proposal after exact escalation quorum without rewriting the original pause. `resolveExecutionAuthorization` accepts either authorization source. `read_files` is marked authorized before enqueue. A retry returns immediately for `executed` and cannot claim an `executing`, `failed`, or `rejected` proposal. Every successful action completion advances the run through `ExecutionRepository`.

- [ ] **Step 9: Wire jobs and GitHub commands**

Add job types to `job-dispatcher.ts`:

```ts
case "run.propose_action": return coordinator.propose(payload.runId);
case "run.execute_action": return coordinator.executeAfterGate(payload.runId, payload.proposalId);
```

Route commands:

```ts
case "next_action":
  await coordinator.requestInteractiveProposal({ runId, githubUserId, githubLogin });
  break;
case "authorize_action":
  await coordinator.authorizeInteractiveAction({ runId, proposalId: command.proposalId, githubUserId, githubLogin, githubCommentId });
  break;
```

When `CheckpointService.recordOperatorClassification` returns `continue`, enqueue `run.execute_action`. When it returns `pause_and_escalate`, enqueue `run.create_escalation`. When it returns `stop`, publish a terminal GitHub comment and do not enqueue another action.

- [ ] **Step 10: Run parity tests and worker integration tests**

Run:

```bash
pnpm --filter @roadmapos/control-plane test -- condition-parity.test.ts
pnpm --filter @roadmapos/domain test -- run-reducer.test.ts
pnpm --filter @roadmapos/control-plane typecheck
```

Expected: governed proposals freeze immediately; interactive proposals wait for a distinct maintainer authorization; both consequential actions converge on the same checkpoint service.

- [ ] **Step 11: Commit the shared execution coordinator**

```bash
git add packages/domain packages/github packages/testkit apps/control-plane
git commit -m "feat: execute both pilot conditions through one safety gate"
```

---

### Task 14: Implement escalation, plan invalidation, deviation disclosure, and draft pull-request creation

**Files:**
- Create: `packages/domain/src/delivery-artifacts.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/db/src/migrations/0004_authorization_carryover.sql`
- Modify: `packages/db/src/schema.ts`
- Create: `apps/control-plane/src/services/escalation-service.ts`
- Create: `apps/control-plane/src/services/deviation-service.ts`
- Create: `apps/control-plane/src/services/pull-request-service.ts`
- Modify: `apps/control-plane/src/services/plan-service.ts`
- Modify: `apps/control-plane/src/services/approval-service.ts`
- Modify: `apps/control-plane/src/services/action-coordinator.ts`
- Modify: `apps/control-plane/src/jobs/github-webhook-handler.ts`
- Modify: `apps/control-plane/src/job-dispatcher.ts`
- Create: `apps/control-plane/test/escalation-and-pr.test.ts`
- Create: `apps/control-plane/test/plan-revision.test.ts`
- Create: `packages/testkit/src/delivery-fixture.ts`
- Modify: `packages/testkit/src/index.ts`
- Create: `apps/control-plane/test/support/plan-revision-fixture.ts`

**Interfaces:**
- Consumes: revealed judgment comparisons, live gate decisions, approvals, action results, and GitHub publishing.
- Produces: `EscalationService`, `DeviationService`, `PullRequestService`, material plan invalidation, editorial approval carryover, and a verified draft PR record.

- [ ] **Step 1: Define delivery artifact schemas**

```ts
// packages/domain/src/delivery-artifacts.ts
import { z } from "zod";

export const EscalationRequestSchema = z.object({
  approvedPlanVersion: z.number().int().positive().nullable(),
  discovered: z.array(z.string().min(1)).min(1),
  differenceFromAuthorization: z.string().min(1),
  necessity: z.string().min(1),
  affectedPaths: z.array(z.string()),
  affectedDependencies: z.array(z.string()),
  affectedInterfaces: z.array(z.string()),
  protectedZones: z.array(z.string()),
  alternatives: z.array(z.object({ label: z.string().min(1), consequence: z.string().min(1) })).min(2),
  recommendation: z.string().min(1),
  approvalConsequence: z.string().min(1),
  rejectionConsequence: z.string().min(1),
  reversible: z.boolean(),
  confidence: z.number().int().min(0).max(100),
  evidence: z.array(z.string().min(1)).min(1)
});
export type EscalationRequest = z.infer<typeof EscalationRequestSchema>;

export const DeviationDisclosureSchema = z.object({
  originalPlanExpectation: z.string().min(1),
  actualImplementationVariation: z.string().min(1),
  continueWithoutEscalationReason: z.string().min(1),
  additionalFiles: z.array(z.string()),
  additionalDependencies: z.array(z.string()),
  reversible: z.boolean(),
  evidence: z.array(z.string().min(1)).min(1),
  confidence: z.number().int().min(0).max(100)
});
export type DeviationDisclosure = z.infer<typeof DeviationDisclosureSchema>;
```

Export both from `packages/domain/src/index.ts` and add schema tests that reject an escalation with no stopping alternative and a deviation with no evidence.

- [ ] **Step 2: Add immutable editorial approval carryover records**

```sql
-- packages/db/src/migrations/0004_authorization_carryover.sql
CREATE TABLE approval_carryovers (
  id uuid PRIMARY KEY,
  approval_id uuid NOT NULL REFERENCES approvals(id),
  from_plan_id uuid NOT NULL REFERENCES execution_plans(id),
  to_plan_id uuid NOT NULL REFERENCES execution_plans(id),
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_plan_id <> to_plan_id),
  UNIQUE (approval_id, to_plan_id)
);

CREATE TRIGGER approval_carryovers_immutable
BEFORE UPDATE OR DELETE ON approval_carryovers
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
```

Add and export the matching Drizzle declaration.

- [ ] **Step 3: Write escalation and PR tests first**

```ts
// apps/control-plane/test/escalation-and-pr.test.ts
import { beforeEach, expect, it } from "vitest";
import { createDatabase } from "@roadmapos/db";
import { FakeGitHubGateway, resetTestDatabase, runEscalationApprovalFixture, runPlanQuorumRestorationFixture, seedRevealedCheckpointFixture } from "@roadmapos/testkit";
import { EscalationService } from "../src/services/escalation-service.js";
import { PullRequestService } from "../src/services/pull-request-service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabase(url);

beforeEach(async () => resetTestDatabase(url));

it("creates a hashed escalation after an operator pause", async () => {
  const fixture = await seedRevealedCheckpointFixture(database, { operatorDecision: "pause_and_escalate", protectedPath: "src/auth/session.ts" });
  const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
  const escalation = await new EscalationService(database, github).create(fixture.checkpointId);
  expect(escalation.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(github.comments.at(-1)).toContain(`/roadmapos approve-escalation ${escalation.version}`);
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
  const github = new FakeGitHubGateway({ permission: "maintain", branchHead: fixture.baseSha });
  const pullRequest = await new PullRequestService(database, github).openDraft(fixture.runId, "Fix parser behavior", fixture.proposalId);
  expect(github.pullRequests[0]?.body).toContain("## Non-escalated deviations");
  expect(github.pullRequests[0]?.body).toContain("shared sanitizer");
  expect(pullRequest.number).toBe(12);
});
```

Implement `packages/testkit/src/delivery-fixture.ts` with these exported signatures, and re-export them from `packages/testkit/src/index.ts`:

```ts
export function seedRevealedCheckpointFixture(
  database: Database,
  input: { operatorDecision: "continue" | "pause_and_escalate" | "stop"; protectedPath: string }
): Promise<{ checkpointId: string; runId: string; baseSha: string }>;

export function seedPullRequestFixture(
  database: Database,
  input: { deviationCount: number }
): Promise<{ runId: string; baseSha: string; proposalId: string }>;

export function runEscalationApprovalFixture(
  database: Database,
  input: { permissionAfterApproval: "maintain" | "read" }
): Promise<{
  liveGateDecision: "pause_and_escalate";
  escalationStatus: "approved" | "awaiting_approval";
  proposalStatus: "executed" | "proposed";
  runState: "proposing_action" | "awaiting_escalation_approval";
  invalidatedApprovalCount: number;
}>;

export function runPlanQuorumRestorationFixture(
  database: Database,
  input: { gateDecision: "continue" | "pause_and_escalate" }
): Promise<{
  invalidatedPlanApprovalCount: number;
  replacementApprovalCount: number;
  originalProposalId: string;
  executedProposalId: string;
  proposalCount: number;
  finalRunState: string;
}>;

```

Create `apps/control-plane/test/support/plan-revision-fixture.ts` with this exported signature:

```ts
export function runRevisionFixture(input: {
  operatorRelationship: "editorial_only" | "material_scope_expansion";
}): Promise<{ activeApprovalCountForNewPlan: number; carriedApprovalCount: number; runState: string }>;
```

The database seed functions may insert baseline immutable GitHub fixture identities and must include the frozen deterministic policy evaluation on every live checkpoint package. `runEscalationApprovalFixture` must call `EscalationService.create`, `ApprovalService.approveEscalation`, `ApprovalService.revalidateBeforeExecution`, and `ActionCoordinator.executeAfterGate`; it must read the original `live_gate_decisions` row to prove it remains `pause_and_escalate`. `runPlanQuorumRestorationFixture` must let the original approver lose permission at the final pre-execution recheck, record a replacement plan approval, and prove that `restoreAfterPlanQuorum` reauthorizes and executes the original proposal rather than asking the agent for another action. `runRevisionFixture` must perform the revision through `CheckpointService`, `PlanService`, and `ApprovalService`. None of these helpers may update approval or run-state rows directly.

- [ ] **Step 4: Create deterministic escalation artifacts**

```ts
// apps/control-plane/src/services/escalation-service.ts
import { and, eq } from "drizzle-orm";
import {
  actionProposals,
  escalations,
  executionPlans,
  governanceCheckpoints,
  judgmentComparisons,
  repositories,
  runs,
  workItems,
  type Database
} from "@roadmapos/db";
import { EscalationRequestSchema, sha256Canonical, type ActionProposal } from "@roadmapos/domain";
import type { GitHubGateway } from "@roadmapos/github";

export class EscalationService {
  constructor(private readonly database: Database, private readonly github: GitHubGateway) {}

  async create(checkpointId: string) {
    const [record] = await this.database.db
      .select({ checkpoint: governanceCheckpoints, comparison: judgmentComparisons, run: runs, proposal: actionProposals, repository: repositories, item: workItems, plan: executionPlans })
      .from(governanceCheckpoints)
      .innerJoin(judgmentComparisons, eq(judgmentComparisons.checkpointId, governanceCheckpoints.id))
      .innerJoin(runs, eq(runs.id, governanceCheckpoints.runId))
      .innerJoin(actionProposals, eq(actionProposals.id, governanceCheckpoints.actionProposalId))
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .leftJoin(executionPlans, eq(executionPlans.id, runs.currentPlanId))
      .where(eq(governanceCheckpoints.id, checkpointId));
    if (!record) throw new Error("Checkpoint not found");
    const operator = record.comparison.operatorPayload as import("@roadmapos/domain").JudgmentClassification;
    if (operator.decision !== "pause_and_escalate") throw new Error("Escalation requires an operator pause decision");
    const action = record.proposal.actionJson as ActionProposal;
    const previous = await this.database.db.select({ version: escalations.version }).from(escalations).where(eq(escalations.runId, record.run.id));
    const version = previous.length + 1;
    const payload = EscalationRequestSchema.parse({
      approvedPlanVersion: record.plan?.version ?? null,
      discovered: operator.facts,
      differenceFromAuthorization: operator.planRelationship,
      necessity: actionSummaryForEscalation(action),
      affectedPaths: action.kind === "apply_patch" ? action.affectedPaths : [],
      affectedDependencies: action.kind === "apply_patch" && action.changesDependencies ? ["Agent-declared dependency change"] : [],
      affectedInterfaces: action.kind === "apply_patch" && action.changesPublicInterface ? ["Agent-declared public interface change"] : [],
      protectedZones: operator.affectedPolicyRules.filter((rule) => rule.startsWith("protected_zone:")),
      alternatives: [
        { label: "Approve this exact escalation", consequence: "The operator may execute the frozen action only." },
        { label: "Reject and request an alternative", consequence: "The action is rejected and the agent must propose a different bounded action." },
        { label: "Stop the run", consequence: "No further repository writes occur." }
      ],
      recommendation: `Pause for maintainer review before ${actionSummaryForEscalation(action)}.`,
      approvalConsequence: "The frozen action becomes eligible for operator-controlled execution.",
      rejectionConsequence: "The frozen action remains unexecuted and the run returns to planning or terminates.",
      reversible: operator.reversible,
      confidence: operator.confidence,
      evidence: operator.facts
    });
    const id = crypto.randomUUID();
    const contentHash = sha256Canonical(payload);
    await this.database.db.insert(escalations).values({ id, runId: record.run.id, checkpointId, version, escalationJson: payload, contentHash, status: "awaiting_approval" });
    await this.github.publishIssueComment({
      installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, issueNumber: record.item.githubIssueNumber,
      body: renderEscalation(version, contentHash, payload)
    });
    return { id, version, contentHash, payload };
  }
}

function actionSummaryForEscalation(action: ActionProposal): string {
  if (action.kind === "apply_patch") return action.summary;
  if (action.kind === "run_validation") return `run validation ${action.commandId}`;
  if (action.kind === "commit_and_push") return action.summary;
  if (action.kind === "open_draft_pr") return `open draft pull request ${action.title}`;
  if (action.kind === "read_files") return action.purpose;
  return action.summary;
}

function renderEscalation(version: number, hash: string, payload: import("@roadmapos/domain").EscalationRequest): string {
  return [
    `## RoadmapOS escalation v${version}`,
    `**Immutable hash:** \`${hash}\``,
    `**Difference from authorization:** ${payload.differenceFromAuthorization}`,
    `**Why this arose:** ${payload.necessity}`,
    "### Evidence",
    ...payload.evidence.map((fact) => `- ${fact}`),
    "### Alternatives",
    ...payload.alternatives.map((alternative) => `- **${alternative.label}:** ${alternative.consequence}`),
    `**Recommendation:** ${payload.recommendation}`,
    "",
    `Approve with \`/roadmapos approve-escalation ${version} ${hash.slice(0, 16)}\` or reject with \`/roadmapos reject-escalation ${version}\`.`
  ].join("\n");
}
```

- [ ] **Step 5: Extend approval service for exact escalation quorum and permission-loss recovery**

Extend the existing `approval-service.ts` imports with `actionProposals`, `approvalCarryovers`, `enqueueJob`, `escalations`, and `governanceCheckpoints`, then append these methods inside `ApprovalService`:

```ts
  async approveEscalation(input: {
    runId: string;
    version: number;
    hashPrefix: string;
    githubUserId: string;
    githubLogin: string;
    githubCommentId: string;
  }): Promise<{ activeApprovals: number; requiredApprovals: number; quorumReached: boolean; invalidatedApprovals: string[] }> {
    const [record] = await this.database.db
      .select({ escalation: escalations, checkpoint: governanceCheckpoints, proposal: actionProposals, run: runs, repository: repositories, policy: repositoryPolicyVersions })
      .from(escalations)
      .innerJoin(governanceCheckpoints, eq(governanceCheckpoints.id, escalations.checkpointId))
      .innerJoin(actionProposals, eq(actionProposals.id, governanceCheckpoints.actionProposalId))
      .innerJoin(runs, eq(runs.id, escalations.runId))
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .where(and(eq(escalations.runId, input.runId), eq(escalations.version, input.version)));
    if (!record) throw new Error("Escalation version not found");
    if (record.escalation.status === "rejected") throw new Error("Escalation is rejected");
    if (!record.escalation.contentHash.startsWith(input.hashPrefix)) throw new Error("Escalation hash prefix does not match");

    const policy = record.policy.policyJson as import("@roadmapos/policy").RepositoryPolicy;
    const permission = await this.github.getRepositoryPermission({
      installationId: record.repository.installationId.toString(),
      owner: record.repository.owner,
      repo: record.repository.name,
      login: input.githubLogin
    });
    if (!meetsPermission(permission, policy.authorization.minimumApprovalRole)) {
      throw new Error(`Escalation approval requires ${policy.authorization.minimumApprovalRole} permission`);
    }

    const inserted = await this.database.db.insert(approvals).values({
      id: crypto.randomUUID(),
      runId: input.runId,
      requestType: "escalation",
      requestId: record.escalation.id,
      requestVersion: record.escalation.version,
      requestHash: record.escalation.contentHash,
      githubUserId: BigInt(input.githubUserId),
      githubLogin: input.githubLogin,
      repositoryPermission: permission,
      policyVersionId: record.policy.id,
      baseSha: record.run.baseSha,
      githubCommentId: BigInt(input.githubCommentId)
    }).onConflictDoNothing().returning({ id: approvals.id });
    if (inserted.length > 0) {
      await appendAuditEvent(this.database, {
        pilotId: record.run.pilotId,
        eventType: "escalation.approved_by_maintainer",
        actorType: "maintainer",
        actorId: input.githubUserId,
        payload: { runId: input.runId, escalationId: record.escalation.id, version: record.escalation.version, contentHash: record.escalation.contentHash, permission }
      });
    }

    const planEligibility = record.run.currentPlanId
      ? await this.revalidatePlanApprovals({
          pilotId: record.run.pilotId,
          runId: input.runId,
          planId: record.run.currentPlanId,
          installationId: record.repository.installationId.toString(),
          owner: record.repository.owner,
          repo: record.repository.name,
          requiredRole: policy.authorization.minimumApprovalRole
        })
      : { distinctEligibleApprovers: 0, invalidatedLogins: [] as string[] };
    if (record.run.condition === "governed_orchestration" && planEligibility.distinctEligibleApprovers < policy.authorization.executionPlanQuorum) {
      if (record.run.state !== "awaiting_plan_approval") {
        await this.execution.transition({
          runId: input.runId, pilotId: record.run.pilotId, condition: "governed_orchestration",
          event: { type: "plan_quorum_lost" }, actorType: "system", actorId: "approval-service"
        });
      }
      return { activeApprovals: 0, requiredApprovals: policy.authorization.escalationQuorum, quorumReached: false, invalidatedApprovals: planEligibility.invalidatedLogins };
    }

    const eligibility = await this.revalidateRequestApprovals({
      pilotId: record.run.pilotId,
      runId: input.runId,
      requestType: "escalation",
      requestId: record.escalation.id,
      installationId: record.repository.installationId.toString(),
      owner: record.repository.owner,
      repo: record.repository.name,
      requiredRole: policy.authorization.minimumApprovalRole
    });
    const quorumReached = eligibility.distinctEligibleApprovers >= policy.authorization.escalationQuorum;
    let newlyApproved = false;
    if (quorumReached) {
      newlyApproved = await this.database.sql.begin(async (transaction) => {
        const [locked] = await transaction<{ status: string }[]>`
          SELECT status FROM escalations WHERE id = ${record.escalation.id}::uuid FOR UPDATE
        `;
        if (!locked || locked.status === "rejected") throw new Error("Escalation is not approvable");
        if (locked.status === "approved") return false;
        await transaction`UPDATE escalations SET status = 'approved' WHERE id = ${record.escalation.id}::uuid`;
        await transaction`
          UPDATE action_proposals SET status = 'authorized'
          WHERE id = ${record.proposal.id}::uuid AND status = 'proposed'
        `;
        await this.execution.transitionTx(transaction, {
          runId: input.runId,
          pilotId: record.run.pilotId,
          condition: record.run.condition as import("@roadmapos/domain").Condition,
          event: { type: "escalation_quorum_reached" },
          actorType: "system",
          actorId: "approval-service"
        });
        return true;
      });
    }
    if (newlyApproved) await enqueueJob(this.database, "run.execute_action", { runId: input.runId, proposalId: record.proposal.id });
    return {
      activeApprovals: eligibility.distinctEligibleApprovers,
      requiredApprovals: policy.authorization.escalationQuorum,
      quorumReached,
      invalidatedApprovals: [...planEligibility.invalidatedLogins, ...eligibility.invalidatedLogins]
    };
  }

  async rejectEscalation(input: { runId: string; version: number; githubUserId: string; githubLogin: string }): Promise<void> {
    const [record] = await this.database.db
      .select({ escalation: escalations, checkpoint: governanceCheckpoints, proposal: actionProposals, run: runs, repository: repositories, policy: repositoryPolicyVersions })
      .from(escalations)
      .innerJoin(governanceCheckpoints, eq(governanceCheckpoints.id, escalations.checkpointId))
      .innerJoin(actionProposals, eq(actionProposals.id, governanceCheckpoints.actionProposalId))
      .innerJoin(runs, eq(runs.id, escalations.runId))
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .where(and(eq(escalations.runId, input.runId), eq(escalations.version, input.version)));
    if (!record) throw new Error("Escalation version not found");
    const policy = record.policy.policyJson as import("@roadmapos/policy").RepositoryPolicy;
    const permission = await this.github.getRepositoryPermission({ installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name, login: input.githubLogin });
    if (!meetsPermission(permission, policy.authorization.minimumApprovalRole)) throw new Error("Insufficient permission to reject escalation");

    await this.database.sql.begin(async (transaction) => {
      const [changed] = await transaction<{ id: string }[]>`
        UPDATE escalations SET status = 'rejected'
        WHERE id = ${record.escalation.id}::uuid AND status = 'awaiting_approval'
        RETURNING id
      `;
      if (!changed) throw new Error("Escalation is not awaiting approval");
      await transaction`UPDATE action_proposals SET status = 'rejected' WHERE id = ${record.proposal.id}::uuid AND status = 'proposed'`;
      await this.execution.transitionTx(transaction, {
        runId: input.runId,
        pilotId: record.run.pilotId,
        condition: record.run.condition as import("@roadmapos/domain").Condition,
        event: { type: "escalation_rejected" },
        actorType: "maintainer",
        actorId: input.githubUserId
      });
    });
  }

  async revalidatePlanApprovals(input: {
    pilotId: string;
    runId: string;
    planId: string;
    installationId: string;
    owner: string;
    repo: string;
    requiredRole: "write" | "maintain" | "admin";
  }): Promise<{ distinctEligibleApprovers: number; invalidatedLogins: string[] }> {
    const direct = await this.database.db.select({ id: approvals.id, login: approvals.githubLogin })
      .from(approvals)
      .leftJoin(approvalInvalidations, eq(approvalInvalidations.approvalId, approvals.id))
      .where(and(eq(approvals.requestType, "execution_plan"), eq(approvals.requestId, input.planId), isNull(approvalInvalidations.id)));
    const carried = await this.database.db.select({ id: approvals.id, login: approvals.githubLogin })
      .from(approvalCarryovers)
      .innerJoin(approvals, eq(approvals.id, approvalCarryovers.approvalId))
      .leftJoin(approvalInvalidations, eq(approvalInvalidations.approvalId, approvals.id))
      .where(and(eq(approvalCarryovers.toPlanId, input.planId), isNull(approvalInvalidations.id)));
    const active = [...new Map([...direct, ...carried].map((approval) => [approval.id, approval])).values()];
    const invalidatedLogins: string[] = [];
    for (const approval of active) {
      const current = await this.github.getRepositoryPermission({ installationId: input.installationId, owner: input.owner, repo: input.repo, login: approval.login });
      if (meetsPermission(current, input.requiredRole)) continue;
      const event = await appendAuditEvent(this.database, {
        pilotId: input.pilotId, eventType: "approval.permission_lost", actorType: "system", actorId: "approval-service",
        payload: { runId: input.runId, approvalId: approval.id, githubLogin: approval.login, requiredRole: input.requiredRole, currentPermission: current }
      });
      await this.database.db.insert(approvalInvalidations).values({
        id: crypto.randomUUID(), approvalId: approval.id, reason: `Repository permission fell below ${input.requiredRole}`, invalidatedByEventId: event.id
      }).onConflictDoNothing();
      invalidatedLogins.push(approval.login);
    }
    const ineligible = new Set(invalidatedLogins);
    return {
      distinctEligibleApprovers: new Set(active.filter((approval) => !ineligible.has(approval.login)).map((approval) => approval.login)).size,
      invalidatedLogins
    };
  }

  async revalidateBeforeExecution(input: { runId: string; checkpointId?: string }): Promise<void> {
    const [record] = await this.database.db
      .select({ run: runs, repository: repositories, policy: repositoryPolicyVersions })
      .from(runs)
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .where(eq(runs.id, input.runId));
    if (!record) throw new Error("Run not found");
    if (record.run.condition === "governed_orchestration") {
      if (!record.run.currentPlanId) throw new Error("Governed run has no current plan");
      const plan = await this.revalidatePlanApprovals({
        pilotId: record.run.pilotId, runId: input.runId, planId: record.run.currentPlanId,
        installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name,
        requiredRole: (record.policy.policyJson as import("@roadmapos/policy").RepositoryPolicy).authorization.minimumApprovalRole
      });
      const policy = record.policy.policyJson as import("@roadmapos/policy").RepositoryPolicy;
      if (plan.distinctEligibleApprovers < policy.authorization.executionPlanQuorum) {
        await this.database.sql`
          UPDATE action_proposals SET status = 'proposed'
          WHERE run_id = ${input.runId}::uuid AND status = 'authorized'
        `;
        if (record.run.state !== "awaiting_plan_approval") {
          await this.execution.transition({ runId: input.runId, pilotId: record.run.pilotId, condition: "governed_orchestration", event: { type: "plan_quorum_lost" }, actorType: "system", actorId: "approval-service" });
        }
        throw new Error("Execution-plan approval quorum was lost; replacement approval is required");
      }
    }

    if (!input.checkpointId) return;
    const [approved] = await this.database.sql<{ escalation_id: string; proposal_id: string; status: string }[]>`
      SELECT e.id AS escalation_id, c.action_proposal_id AS proposal_id, e.status
      FROM escalations e
      JOIN governance_checkpoints c ON c.id = e.checkpoint_id
      WHERE e.checkpoint_id = ${input.checkpointId}::uuid
      ORDER BY e.version DESC
      LIMIT 1
    `;
    if (!approved || approved.status !== "approved") return;
    const policy = record.policy.policyJson as import("@roadmapos/policy").RepositoryPolicy;
    const escalation = await this.revalidateRequestApprovals({
      pilotId: record.run.pilotId, runId: input.runId, requestType: "escalation", requestId: approved.escalation_id,
      installationId: record.repository.installationId.toString(), owner: record.repository.owner, repo: record.repository.name,
      requiredRole: policy.authorization.minimumApprovalRole
    });
    if (escalation.distinctEligibleApprovers >= policy.authorization.escalationQuorum) return;

    await this.database.sql.begin(async (transaction) => {
      await transaction`UPDATE escalations SET status = 'awaiting_approval' WHERE id = ${approved.escalation_id}::uuid AND status = 'approved'`;
      await transaction`UPDATE action_proposals SET status = 'proposed' WHERE id = ${approved.proposal_id}::uuid AND status = 'authorized'`;
      await this.execution.transitionTx(transaction, {
        runId: input.runId, pilotId: record.run.pilotId, condition: record.run.condition as import("@roadmapos/domain").Condition,
        event: { type: "escalation_quorum_lost" }, actorType: "system", actorId: "approval-service"
      });
    });
    throw new Error("Escalation approval quorum was lost; replacement approval is required");
  }
```

Use the same `meetsPermission` function as plan approval. `revalidateRequestApprovals` writes one immutable `approval_invalidations` row for each permission loss and never aborts the run merely because an approver became ineligible. A replacement approver can then restore the configured quorum. The original `live_gate_decisions.operator_decision = 'pause_and_escalate'` row remains unchanged.

Modify `ActionCoordinator` to receive `private readonly authorizationGuard: Pick<ApprovalService, "revalidateBeforeExecution">` as its final constructor dependency. In `executeAfterGate`, call the guard immediately before resolving/claiming the proposal:

```ts
const [checkpoint] = action.kind === "read_files"
  ? []
  : await this.database.sql<{ id: string }[]>`SELECT id FROM governance_checkpoints WHERE action_proposal_id = ${proposalId}::uuid`;
if (action.kind !== "read_files" && !checkpoint) throw new Error("Consequential proposal has no checkpoint");
await this.authorizationGuard.revalidateBeforeExecution({ runId, checkpointId: checkpoint?.id });
if (checkpoint) {
  const authorization = await this.checkpoints.resolveExecutionAuthorization(checkpoint.id);
  if (!authorization.authorized) throw new Error(`Action is not authorized: ${authorization.source}`);
}
```

Update every `ActionCoordinator` construction in the control plane and tests to inject the same `ApprovalService` instance used by command handling. This makes the live permission recheck occur at the last safe point before execution, not only when the approval was first recorded.

- [ ] **Step 6: Record non-escalated deviations after an operator continue**

```ts
// apps/control-plane/src/services/deviation-service.ts
import { eq } from "drizzle-orm";
import { actionProposals, deviations, executionPlans, governanceCheckpoints, judgmentComparisons, runs, type Database } from "@roadmapos/db";
import { DeviationDisclosureSchema, sha256Canonical, type ActionProposal } from "@roadmapos/domain";

export class DeviationService {
  constructor(private readonly database: Database) {}

  async recordIfRequired(checkpointId: string) {
    const [record] = await this.database.db.select({ checkpoint: governanceCheckpoints, comparison: judgmentComparisons, proposal: actionProposals, run: runs, plan: executionPlans })
      .from(governanceCheckpoints)
      .innerJoin(judgmentComparisons, eq(judgmentComparisons.checkpointId, governanceCheckpoints.id))
      .innerJoin(actionProposals, eq(actionProposals.id, governanceCheckpoints.actionProposalId))
      .innerJoin(runs, eq(runs.id, governanceCheckpoints.runId))
      .leftJoin(executionPlans, eq(executionPlans.id, runs.currentPlanId))
      .where(eq(governanceCheckpoints.id, checkpointId));
    if (!record) throw new Error("Checkpoint not found");
    const operator = record.comparison.operatorPayload as import("@roadmapos/domain").JudgmentClassification;
    if (operator.decision !== "continue" || !["editorial_only", "materially_equivalent_variation"].includes(operator.planRelationship)) return null;
    const action = record.proposal.actionJson as ActionProposal;
    const anticipated = (record.plan?.planJson as import("@roadmapos/domain").ExecutionPlanDraft | null)?.anticipatedPaths ?? [];
    const affected = action.kind === "apply_patch" ? action.affectedPaths : [];
    const additionalFiles = affected.filter((path) => !anticipated.includes(path));
    const payload = DeviationDisclosureSchema.parse({
      originalPlanExpectation: anticipated.length > 0 ? anticipated.join(", ") : "No path expectation was recorded",
      actualImplementationVariation: actionSummaryForDeviation(action),
      continueWithoutEscalationReason: operator.facts.join(" "),
      additionalFiles,
      additionalDependencies: action.kind === "apply_patch" && action.changesDependencies ? ["Agent-declared dependency change"] : [],
      reversible: operator.reversible,
      evidence: operator.facts,
      confidence: operator.confidence
    });
    const id = crypto.randomUUID();
    const contentHash = sha256Canonical(payload);
    await this.database.db.insert(deviations).values({ id, runId: record.run.id, checkpointId, disclosureJson: payload, contentHash });
    return { id, contentHash, payload };
  }
}

function actionSummaryForDeviation(action: ActionProposal): string {
  if (action.kind === "apply_patch") return `${action.summary}; affected ${action.affectedPaths.join(", ")}`;
  if (action.kind === "run_validation") return `Validation ${action.commandId}`;
  if (action.kind === "commit_and_push") return action.summary;
  if (action.kind === "open_draft_pr") return action.title;
  if (action.kind === "read_files") return action.purpose;
  return action.summary;
}
```

Call `recordIfRequired` immediately after operator `continue` and before action execution.

- [ ] **Step 7: Implement material plan invalidation and editorial carryover through the reducer**

Extend `PlanService` with a final `CheckpointService` dependency and add the following methods. Extend its Drizzle imports with `and`, `eq`, and `isNull`; extend its database imports with `approvals`, `approvalCarryovers`, `approvalInvalidations`, `executionPlans`, `governanceCheckpoints`, `judgmentComparisons`, `repositories`, `repositoryPolicyVersions`, `runs`, and `workItems`; import `CheckpointPackageSchema` and `sha256Canonical` from `@roadmapos/domain`; and import `CheckpointService` from `./checkpoint-service.js`.

```ts
  async revisePlan(runId: string, maintainerFeedback: string): Promise<{ planId: string; version: number; contentHash: string; checkpointId: string }> {
    const [record] = await this.database.db
      .select({ run: runs, current: executionPlans, item: workItems, repository: repositories, policy: repositoryPolicyVersions })
      .from(runs)
      .innerJoin(executionPlans, eq(executionPlans.id, runs.currentPlanId))
      .innerJoin(workItems, eq(workItems.id, runs.workItemId))
      .innerJoin(repositories, eq(repositories.id, runs.repositoryId))
      .innerJoin(repositoryPolicyVersions, eq(repositoryPolicyVersions.id, runs.policyVersionId))
      .where(eq(runs.id, runId));
    if (!record) throw new Error("Run or current plan not found");
    if (record.run.condition !== "governed_orchestration") throw new Error("Only governed runs have execution plans");
    if (!maintainerFeedback.trim()) throw new Error("Revision feedback is required");

    const generated = await this.agent.generatePlan({
      repositoryId: record.repository.id,
      issueNumber: record.item.githubIssueNumber,
      baseSha: record.run.baseSha,
      policyHash: record.policy.policyHash,
      roadmapItem: {
        title: record.item.title,
        body: JSON.stringify({ previousPlan: record.current.planJson, maintainerFeedback }),
        acceptanceCriteria: record.item.acceptanceCriteria as string[]
      },
      repositoryContext: []
    });
    const planId = crypto.randomUUID();
    const version = record.current.version + 1;
    const contentHash = sha256Canonical(generated.value);
    const facts = diffExecutionPlans(record.current.planJson as import("@roadmapos/domain").ExecutionPlanDraft, generated.value);
    await this.database.db.insert(executionPlans).values({
      id: planId,
      runId,
      version,
      planJson: generated.value,
      contentHash,
      baseSha: record.run.baseSha,
      supersedesPlanId: record.current.id,
      changeClassification: "pending_operator_classification"
    });
    const checkpointPackage = CheckpointPackageSchema.parse({
      schemaVersion: 1,
      repository: { owner: record.repository.owner, name: record.repository.name, baseSha: record.run.baseSha },
      policyHash: record.policy.policyHash,
      authorization: { kind: "execution_plan", version: record.current.version, contentHash: record.current.contentHash },
      contemplatedAction: {
        kind: "plan_revision",
        summary: `Replace plan v${record.current.version} with v${version}`,
        affectedPaths: generated.value.anticipatedPaths,
        patchHash: contentHash
      },
      discoveredFacts: facts,
      validationState: { completedCommandIds: [], failingCommandIds: [] },
      reversible: true,
      createdAt: new Date().toISOString()
    });
    const checkpoint = await this.checkpoints.freeze({ runId, source: "plan_revision", package: checkpointPackage });
    return { planId, version, contentHash, checkpointId: checkpoint.id };
  }

  async applyRevisionDecision(checkpointId: string, operatorId: string): Promise<"editorial_carried" | "approval_required" | "stopped"> {
    const [record] = await this.database.db
      .select({ checkpoint: governanceCheckpoints, comparison: judgmentComparisons, run: runs, oldPlan: executionPlans })
      .from(governanceCheckpoints)
      .innerJoin(judgmentComparisons, eq(judgmentComparisons.checkpointId, governanceCheckpoints.id))
      .innerJoin(runs, eq(runs.id, governanceCheckpoints.runId))
      .innerJoin(executionPlans, eq(executionPlans.id, runs.currentPlanId))
      .where(eq(governanceCheckpoints.id, checkpointId));
    if (!record || record.checkpoint.source !== "plan_revision") throw new Error("Plan-revision checkpoint not found");
    const frozenPackage = CheckpointPackageSchema.parse(record.checkpoint.packageJson);
    const candidateHash = frozenPackage.contemplatedAction.patchHash;
    if (!candidateHash) throw new Error("Plan-revision checkpoint is missing its candidate-plan hash");
    const [candidate] = await this.database.db.select().from(executionPlans)
      .where(and(
        eq(executionPlans.runId, record.run.id),
        eq(executionPlans.supersedesPlanId, record.oldPlan.id),
        eq(executionPlans.contentHash, candidateHash)
      ));
    if (!candidate) throw new Error("The exact candidate plan committed by the checkpoint was not found");
    const operator = record.comparison.operatorPayload as import("@roadmapos/domain").JudgmentClassification;

    if (operator.decision === "stop") {
      await this.execution.transition({
        runId: record.run.id, pilotId: record.run.pilotId, condition: "governed_orchestration",
        event: { type: "operator_stop" }, actorType: "operator", actorId: operatorId
      });
      return "stopped";
    }

    const active = await this.database.db.select({ id: approvals.id })
      .from(approvals)
      .leftJoin(approvalInvalidations, eq(approvalInvalidations.approvalId, approvals.id))
      .where(and(eq(approvals.requestType, "execution_plan"), eq(approvals.requestId, record.oldPlan.id), isNull(approvalInvalidations.id)));

    if (operator.decision === "continue" && operator.planRelationship === "editorial_only") {
      await this.database.db.transaction(async (transaction) => {
        for (const approval of active) {
          await transaction.insert(approvalCarryovers).values({
            id: crypto.randomUUID(), approvalId: approval.id, fromPlanId: record.oldPlan.id, toPlanId: candidate.id,
            checkpointId, rationale: operator.facts.join(" ")
          });
        }
        await transaction.update(runs).set({ currentPlanId: candidate.id, updatedAt: new Date() }).where(eq(runs.id, record.run.id));
      });
      await this.execution.transition({
        runId: record.run.id, pilotId: record.run.pilotId, condition: "governed_orchestration",
        event: { type: "editorial_revision_accepted" }, actorType: "operator", actorId: operatorId
      });
      return "editorial_carried";
    }

    const invalidationEvent = await appendAuditEvent(this.database, {
      pilotId: record.run.pilotId, eventType: "plan.revision_invalidated_prior_approvals", actorType: "operator", actorId: operatorId,
      payload: { runId: record.run.id, fromPlanId: record.oldPlan.id, toPlanId: candidate.id, checkpointId, operatorDecision: operator.decision, planRelationship: operator.planRelationship }
    });
    await this.database.db.transaction(async (transaction) => {
      for (const approval of active) {
        await transaction.insert(approvalInvalidations).values({
          id: crypto.randomUUID(), approvalId: approval.id, reason: `Plan superseded by material revision ${candidate.version}`, invalidatedByEventId: invalidationEvent.id
        }).onConflictDoNothing();
      }
      await transaction.update(runs).set({ currentPlanId: candidate.id, updatedAt: new Date() }).where(eq(runs.id, record.run.id));
    });
    await this.execution.transition({
      runId: record.run.id, pilotId: record.run.pilotId, condition: "governed_orchestration",
      event: { type: "material_revision_requires_approval" }, actorType: "operator", actorId: operatorId
    });
    return "approval_required";
  }
```

Add this deterministic helper beside `renderPlanComment`:

```ts
function diffExecutionPlans(previous: import("@roadmapos/domain").ExecutionPlanDraft, next: import("@roadmapos/domain").ExecutionPlanDraft): string[] {
  const fields: Array<keyof import("@roadmapos/domain").ExecutionPlanDraft> = [
    "problemInterpretation", "acceptanceCriteria", "expectedPublicBehavior", "implementationSteps",
    "anticipatedPaths", "dependencies", "protectedZoneExpectations", "verificationCommandIds", "risks", "rollback"
  ];
  return fields
    .filter((field) => sha256Canonical(previous[field]) !== sha256Canonical(next[field]))
    .map((field) => `${String(field)} changed from ${sha256Canonical(previous[field])} to ${sha256Canonical(next[field])}`);
}
```

After `CheckpointService.recordOperatorClassification` reveals a `plan_revision` checkpoint, enqueue a job that calls `applyRevisionDecision`. The candidate plan does not become current before that job. Editorial carryover is counted by `ApprovalService.revalidatePlanApprovals`; every other non-stop result invalidates the old approvals and requires a fresh quorum. No plan-revision path writes `runs.state` directly.

- [ ] **Step 8: Build the draft pull-request body from durable evidence**

```ts
// apps/control-plane/src/services/pull-request-service.ts
import { asc, eq } from "drizzle-orm";
import { actionProposals, deviations, draftPullRequests, escalations, executionPlans, ExecutionRepository, repositories, runs, runTranscriptEntries, workItems, type Database } from "@roadmapos/db";
import { sha256Text } from "@roadmapos/domain";
import type { GitHubGateway } from "@roadmapos/github";

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

    const deviationRows = await this.database.db.select().from(deviations).where(eq(deviations.runId, runId));
    const escalationRows = await this.database.db.select().from(escalations).where(eq(escalations.runId, runId));
    const transcript = await this.database.db.select().from(runTranscriptEntries).where(eq(runTranscriptEntries.runId, runId)).orderBy(asc(runTranscriptEntries.sequence));
    const plan = record.plan?.planJson as import("@roadmapos/domain").ExecutionPlanDraft | undefined;
    const body = renderPullRequestBody({ record, plan, deviations: deviationRows, escalations: escalationRows, transcript });
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

  private async completeProjection(run: typeof runs.$inferSelect, proposalId: string): Promise<void> {
    await this.database.db.update(actionProposals).set({ status: "executed", executedAt: new Date() }).where(eq(actionProposals.id, proposalId));
    const [current] = await this.database.db.select({ state: runs.state }).from(runs).where(eq(runs.id, run.id));
    if (!current) throw new Error("Run not found while finalizing draft PR");
    if (current.state === "awaiting_review_ready") return;
    if (current.state !== "executing_action") throw new Error(`Cannot finalize draft PR while run is ${current.state}`);
    await this.execution.transition({
      runId: run.id,
      pilotId: run.pilotId,
      condition: run.condition as import("@roadmapos/domain").Condition,
      event: { type: "draft_pr_opened" },
      actorType: "system",
      actorId: "pull-request-service"
    });
  }
}
```

Implement `renderPullRequestBody` to emit these exact sections:

```text
## Why
## What changed
## Acceptance criteria and evidence
## Tests and validation
## Risk and rollback
## Non-escalated deviations
## Escalation decisions
## Known limitations
## Remaining maintainer decisions
## Authorization record
```

The authorization record contains the plan or instruction hash, policy hash, base SHA, and links to GitHub records. It never includes encrypted classifications or private model reasoning.

- [ ] **Step 9: Wire finalization jobs and commands**

Add jobs:

```ts
case "run.create_escalation": return escalationService.create(payload.checkpointId);
case "run.finalize_pr": return pullRequestService.openDraft(payload.runId, payload.title ?? "RoadmapOS draft change", payload.proposalId);
```

Route `approve_escalation`, `reject_escalation`, and `revise_plan` commands to their services. On an `open_draft_pr` action, ignore the model-supplied body and use `PullRequestService`'s evidence-derived body. On a `finish` action before a PR exists, reject the action and ask the agent to propose `open_draft_pr`.

- [ ] **Step 10: Verify plan revision behavior**

```ts
// apps/control-plane/test/plan-revision.test.ts
import { expect, it } from "vitest";
import { runRevisionFixture } from "./support/plan-revision-fixture.js";

it("invalidates approvals for a material revision and carries them only after an operator editorial decision", async () => {
  const material = await runRevisionFixture({ operatorRelationship: "material_scope_expansion" });
  expect(material.activeApprovalCountForNewPlan).toBe(0);
  expect(material.runState).toBe("awaiting_plan_approval");

  const editorial = await runRevisionFixture({ operatorRelationship: "editorial_only" });
  expect(editorial.carriedApprovalCount).toBe(1);
  expect(editorial.runState).toBe("proposing_action");
});
```

Run:

```bash
pnpm --filter @roadmapos/control-plane test -- escalation-and-pr.test.ts plan-revision.test.ts
```

Expected: protected work waits for exact escalation quorum; all deviations appear in the PR; material revisions lose approval; editorial carryover requires the operator label.

- [ ] **Step 11: Run the full execution milestone**

```bash
pnpm --filter @roadmapos/github --filter @roadmapos/agent --filter @roadmapos/runner test
pnpm --filter @roadmapos/control-plane test
pnpm --filter @roadmapos/portal test
pnpm typecheck
pnpm lint
```

Expected: all tests pass and no GitHub, model-provider, or Docker network call occurs in the deterministic suite.

- [ ] **Step 12: Commit the complete supervised workflow**

```bash
git add packages apps .env.example package.json pnpm-lock.yaml
git commit -m "feat: complete supervised GitHub delivery workflow"
```

## Milestone 2 verification

- [ ] Run a local fake-repository scenario:

```bash
pnpm --filter @roadmapos/control-plane test -- full-supervised-workflow.test.ts
```

Expected sequence:

```text
ready label
→ governed plan v1 and immutable hash
→ live maintainer permission and quorum
→ action proposal
→ hidden agent classification
→ independent operator classification
→ continue or escalation
→ restricted patch and validation
→ bot branch and commits
→ evidence-derived draft pull request
```

- [ ] Prove the negative capabilities:

```bash
rg "\.merge\(|createDeployment|createRelease|packages\." apps packages
```

Expected: no production code path invokes merge, deployment, release, or package-publication APIs.

- [ ] Prove operator blinding:

```bash
pnpm --filter @roadmapos/control-plane test -- checkpoint-blinding.test.ts
```

Expected: the operator GET payload contains no agent classification fields before submission.
