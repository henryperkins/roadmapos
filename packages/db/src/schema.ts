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
