import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const pilotStudies = pgTable("pilot_studies", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  preregistrationHash: char("preregistration_hash", { length: 64 }),
  observationWindowDays: integer("observation_window_days").notNull().default(14),
  createdAt
});

export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey(),
  pilotId: uuid("pilot_id").notNull().references(() => pilotStudies.id),
  githubRepositoryId: bigint("github_repository_id", { mode: "bigint" }).notNull(),
  installationId: bigint("installation_id", { mode: "bigint" }).notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull(),
  policyPath: text("policy_path").notNull().default(".roadmapos/policy.yml"),
  createdAt
});

export const repositoryPolicyVersions = pgTable("repository_policy_versions", {
  id: uuid("id").primaryKey(),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  sourceCommitSha: char("source_commit_sha", { length: 40 }).notNull(),
  policyJson: jsonb("policy_json").notNull(),
  policyHash: char("policy_hash", { length: 64 }).notNull(),
  createdBy: text("created_by").notNull(),
  createdAt
});

export const participants = pgTable("participants", {
  id: uuid("id").primaryKey(),
  pilotId: uuid("pilot_id").notNull().references(() => pilotStudies.id),
  githubUserId: bigint("github_user_id", { mode: "bigint" }).notNull(),
  githubLogin: text("github_login").notNull(),
  studyRole: text("study_role").notNull(),
  createdAt
});

export const internalAccessTokens = pgTable("internal_access_tokens", {
  id: uuid("id").primaryKey(),
  participantId: uuid("participant_id").notNull().references(() => participants.id),
  tokenSha256: char("token_sha256", { length: 64 }).notNull(),
  label: text("label").notNull(),
  createdAt,
  revokedAt: timestamp("revoked_at", { withTimezone: true })
});

export const workItems = pgTable("work_items", {
  id: uuid("id").primaryKey(),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  githubIssueNumber: integer("github_issue_number").notNull(),
  githubIssueNodeId: text("github_issue_node_id").notNull(),
  title: text("title").notNull(),
  acceptanceCriteria: jsonb("acceptance_criteria").notNull(),
  expectedEffortBand: text("expected_effort_band").notNull(),
  expectedGovernanceExposure: text("expected_governance_exposure").notNull(),
  condition: text("condition"),
  executionOrder: integer("execution_order"),
  createdAt
});

export const matchedPairs = pgTable("matched_pairs", {
  id: uuid("id").primaryKey(),
  pilotId: uuid("pilot_id").notNull().references(() => pilotStudies.id),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id),
  workItemAId: uuid("work_item_a_id").notNull().references(() => workItems.id),
  workItemBId: uuid("work_item_b_id").notNull().references(() => workItems.id),
  governanceBearing: boolean("governance_bearing").notNull(),
  matchingRecord: jsonb("matching_record").notNull(),
  assignmentRecord: jsonb("assignment_record"),
  assignmentHash: char("assignment_hash", { length: 64 }),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  createdAt
}, (table) => [
  uniqueIndex("matched_pairs_work_item_a_idx").on(table.workItemAId),
  uniqueIndex("matched_pairs_work_item_b_idx").on(table.workItemBId),
  check("matched_pairs_distinct_items", sql`${table.workItemAId} <> ${table.workItemBId}`)
]);

export const pilotEvents = pgTable("pilot_events", {
  id: uuid("id").primaryKey(),
  pilotId: uuid("pilot_id").notNull().references(() => pilotStudies.id),
  sequence: integer("sequence").notNull(),
  eventType: text("event_type").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  payload: jsonb("payload").notNull(),
  previousHash: char("previous_hash", { length: 64 }),
  eventHash: char("event_hash", { length: 64 }).notNull(),
  createdAt
}, (table) => [
  uniqueIndex("pilot_events_sequence_idx").on(table.pilotId, table.sequence),
  uniqueIndex("pilot_events_hash_idx").on(table.pilotId, table.eventHash)
]);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey(),
  jobType: text("job_type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("queued"),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  lockedBy: text("locked_by"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt,
  completedAt: timestamp("completed_at", { withTimezone: true })
}, (table) => [index("jobs_claim_idx").on(table.status, table.availableAt, table.createdAt)]);

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

export const checkpointReveals = pgTable("checkpoint_reveals", {
  id: uuid("id").primaryKey(),
  checkpointId: uuid("checkpoint_id").notNull().references(() => governanceCheckpoints.id),
  comparisonId: uuid("comparison_id").notNull().references(() => judgmentComparisons.id),
  revealedAt: timestamp("revealed_at", { withTimezone: true }).notNull().defaultNow()
});

export const approvalCarryovers = pgTable("approval_carryovers", {
  id: uuid("id").primaryKey(),
  approvalId: uuid("approval_id").notNull().references(() => approvals.id),
  fromPlanId: uuid("from_plan_id").notNull().references(() => executionPlans.id),
  toPlanId: uuid("to_plan_id").notNull().references(() => executionPlans.id),
  checkpointId: uuid("checkpoint_id").notNull().references(() => governanceCheckpoints.id),
  rationale: text("rationale").notNull(),
  createdAt
});
