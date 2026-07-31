import type { Database } from "./client.js";

/**
 * postgres's `TransactionSql` extends `Sql`, so one parameter type accepts both a pooled client and
 * an open transaction without widening into a union the tagged-template overloads cannot resolve.
 */
type Executor = Database["sql"];

/**
 * Sequence and version numbers are allocated by the database inside the inserting statement, never
 * by reading a count into JavaScript and adding one. Two concurrent workers computing `n + 1` from
 * the same snapshot would both pick the same number; here the loser hits the unique constraint.
 */
export async function insertTranscriptEntry(
  executor: Executor,
  input: { runId: string; role: "system" | "agent" | "maintainer" | "tool" | "operator"; content: string; contentHash: string }
): Promise<number> {
  const [row] = await executor<{ sequence: number }[]>`
    INSERT INTO run_transcript_entries (id, run_id, sequence, role, content, content_hash)
    SELECT ${crypto.randomUUID()}::uuid, ${input.runId}::uuid, coalesce(max(sequence), 0) + 1, ${input.role}, ${input.content}, ${input.contentHash}
    FROM run_transcript_entries WHERE run_id = ${input.runId}::uuid
    RETURNING sequence
  `;
  if (!row) throw new Error("Unable to allocate a transcript sequence");
  return row.sequence;
}

export async function insertActionProposal(
  executor: Executor,
  input: { id: string; runId: string; action: unknown; actionHash: string; maxActions: number }
): Promise<number> {
  const [row] = await executor<{ sequence: number }[]>`
    INSERT INTO action_proposals (id, run_id, sequence, action_json, action_hash, status)
    SELECT ${input.id}::uuid, ${input.runId}::uuid, coalesce(max(sequence), 0) + 1,
           ${JSON.stringify(input.action)}::jsonb, ${input.actionHash}, 'proposed'
    FROM action_proposals WHERE run_id = ${input.runId}::uuid
    HAVING count(*) < ${input.maxActions}
    RETURNING sequence
  `;
  if (!row) throw new Error(`Run exceeded the ${String(input.maxActions)}-action pilot limit`);
  return row.sequence;
}

export async function insertExplicitInstruction(
  executor: Executor,
  input: { id: string; runId: string; instructionText: string; contentHash: string; githubUserId: bigint; githubCommentId: bigint; repositoryPermission: string }
): Promise<number> {
  const [row] = await executor<{ version: number }[]>`
    INSERT INTO explicit_instructions (id, run_id, version, instruction_text, content_hash, github_user_id, github_comment_id, repository_permission)
    SELECT ${input.id}::uuid, ${input.runId}::uuid, coalesce(max(version), 0) + 1, ${input.instructionText}, ${input.contentHash},
           ${String(input.githubUserId)}::bigint, ${String(input.githubCommentId)}::bigint, ${input.repositoryPermission}
    FROM explicit_instructions WHERE run_id = ${input.runId}::uuid
    RETURNING version
  `;
  if (!row) throw new Error("Unable to allocate an instruction version");
  return row.version;
}

export async function insertEscalation(
  executor: Executor,
  input: { id: string; runId: string; checkpointId: string; escalation: unknown; contentHash: string }
): Promise<number> {
  const [row] = await executor<{ version: number }[]>`
    INSERT INTO escalations (id, run_id, checkpoint_id, version, escalation_json, content_hash, status)
    SELECT ${input.id}::uuid, ${input.runId}::uuid, ${input.checkpointId}::uuid, coalesce(max(version), 0) + 1,
           ${JSON.stringify(input.escalation)}::jsonb, ${input.contentHash}, 'awaiting_approval'
    FROM escalations WHERE run_id = ${input.runId}::uuid
    RETURNING version
  `;
  if (!row) throw new Error("Unable to allocate an escalation version");
  return row.version;
}

export async function insertExecutionPlanVersion(
  executor: Executor,
  input: { id: string; runId: string; plan: unknown; contentHash: string; baseSha: string; supersedesPlanId: string | null; changeClassification: string }
): Promise<number> {
  const [row] = await executor<{ version: number }[]>`
    INSERT INTO execution_plans (id, run_id, version, plan_json, content_hash, base_sha, supersedes_plan_id, change_classification)
    SELECT ${input.id}::uuid, ${input.runId}::uuid, coalesce(max(version), 0) + 1, ${JSON.stringify(input.plan)}::jsonb,
           ${input.contentHash}, ${input.baseSha}, ${input.supersedesPlanId}::uuid, ${input.changeClassification}
    FROM execution_plans WHERE run_id = ${input.runId}::uuid
    RETURNING version
  `;
  if (!row) throw new Error("Unable to allocate a plan version");
  return row.version;
}

/**
 * Allocates the initial plan version and makes it current in one statement, so a crash can never
 * leave a run pointing at no plan while a plan row exists (or the reverse).
 */
export async function insertInitialPlanAsCurrent(
  executor: Executor,
  input: { id: string; runId: string; plan: unknown; contentHash: string; baseSha: string }
): Promise<number> {
  const [row] = await executor<{ version: number }[]>`
    WITH inserted AS (
      INSERT INTO execution_plans (id, run_id, version, plan_json, content_hash, base_sha, change_classification)
      SELECT ${input.id}::uuid, ${input.runId}::uuid, coalesce(max(version), 0) + 1, ${JSON.stringify(input.plan)}::jsonb,
             ${input.contentHash}, ${input.baseSha}, 'initial'
      FROM execution_plans WHERE run_id = ${input.runId}::uuid
      RETURNING id, version
    )
    UPDATE runs SET current_plan_id = (SELECT id FROM inserted), updated_at = now()
    WHERE id = ${input.runId}::uuid
    RETURNING (SELECT version FROM inserted) AS version
  `;
  if (!row) throw new Error("Unable to allocate the initial plan version");
  return row.version;
}
