import { sha256Canonical } from "@roadmapos/domain";
import type { Database } from "./client.js";

export type AttemptState = "running" | "succeeded" | "failed" | "reconciling";
export type EffectKind = "git_commit_push" | "github_draft_pull_request" | "github_issue_comment" | "github_check";
export type OutboxState = "pending" | "dispatched" | "confirmed" | "abandoned";

export interface ExecutionAttempt {
  id: string;
  runId: string;
  proposalId: string;
  attempt: number;
  actionHash: string;
  idempotencyKey: string;
  state: AttemptState;
}

export interface OutboxRecord {
  id: string;
  attemptId: string;
  runId: string;
  effectKind: EffectKind;
  idempotencyKey: string;
  request: unknown;
  state: OutboxState;
  externalId: string | null;
}

export const DEFAULT_LEASE_SECONDS = 900;

/**
 * The operation-specific idempotency key. It is derived from the run, the proposal and the exact
 * authorized action content, so a retry of the same authorized action reuses the same key while a
 * different action can never collide with it.
 */
export function executionIdempotencyKey(input: { runId: string; proposalId: string; actionHash: string }): string {
  return `run:${input.runId}:proposal:${input.proposalId}:action:${input.actionHash}`;
}

export function effectIdempotencyKey(input: { attemptKey: string; effectKind: EffectKind; discriminator?: string }): string {
  return `${input.attemptKey}:${input.effectKind}${input.discriminator === undefined ? "" : `:${input.discriminator}`}`;
}

export interface ClaimOutcome {
  claimed: ExecutionAttempt | null;
  /** Set when an attempt exists that this worker may not claim, so callers can report precisely. */
  blockedBy: { attemptId: string; state: AttemptState } | null;
}

/**
 * Opens or resumes a leased attempt for one authorized action.
 *
 * A live lease held by another worker blocks the claim. An expired lease does not immediately
 * become claimable: the attempt moves to `reconciling` first, because a crashed worker may have
 * already produced an external effect that has to be accounted for before anything is retried.
 */
export async function claimExecutionAttempt(
  database: Database,
  input: { runId: string; proposalId: string; actionHash: string; leaseOwner: string; leaseSeconds?: number }
): Promise<ClaimOutcome> {
  const idempotencyKey = executionIdempotencyKey(input);
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  return database.sql.begin<ClaimOutcome>(async (transaction) => {
    const existing = await transaction<{ id: string; attempt: number; state: AttemptState; expired: boolean }[]>`
      SELECT id, attempt, state, lease_expires_at < now() AS expired
      FROM execution_attempts
      WHERE proposal_id = ${input.proposalId}::uuid
      ORDER BY attempt DESC
      FOR UPDATE
    `;
    const latest = existing[0];
    if (latest?.state === "succeeded") return { claimed: null, blockedBy: { attemptId: latest.id, state: "succeeded" } };
    if (latest && (latest.state === "running" || latest.state === "reconciling") && !latest.expired) {
      return { claimed: null, blockedBy: { attemptId: latest.id, state: latest.state } };
    }
    if (latest && (latest.state === "running" || latest.state === "reconciling") && latest.expired) {
      await transaction`
        UPDATE execution_attempts
        SET state = 'reconciling', lease_owner = ${input.leaseOwner}, lease_expires_at = now() + make_interval(secs => ${leaseSeconds})
        WHERE id = ${latest.id}::uuid
      `;
      return {
        claimed: { id: latest.id, runId: input.runId, proposalId: input.proposalId, attempt: latest.attempt, actionHash: input.actionHash, idempotencyKey, state: "reconciling" },
        blockedBy: null
      };
    }

    const id = crypto.randomUUID();
    const attempt = (latest?.attempt ?? 0) + 1;
    await transaction`
      INSERT INTO execution_attempts (id, run_id, proposal_id, attempt, action_hash, idempotency_key, state, lease_owner, lease_expires_at)
      VALUES (${id}::uuid, ${input.runId}::uuid, ${input.proposalId}::uuid, ${attempt}, ${input.actionHash},
              ${`${idempotencyKey}:attempt:${String(attempt)}`}, 'running', ${input.leaseOwner}, now() + make_interval(secs => ${leaseSeconds}))
    `;
    return {
      claimed: { id, runId: input.runId, proposalId: input.proposalId, attempt, actionHash: input.actionHash, idempotencyKey, state: "running" },
      blockedBy: null
    };
  });
}

export async function markAttemptRunning(database: Database, attemptId: string): Promise<void> {
  await database.sql`UPDATE execution_attempts SET state = 'running' WHERE id = ${attemptId}::uuid AND state = 'reconciling'`;
}

export async function completeAttempt(database: Database, attemptId: string, result: unknown): Promise<void> {
  await database.sql`
    UPDATE execution_attempts
    SET state = 'succeeded', finished_at = now(), result_hash = ${sha256Canonical(result)}
    WHERE id = ${attemptId}::uuid AND state IN ('running', 'reconciling')
  `;
}

export async function failAttempt(database: Database, attemptId: string, message: string): Promise<void> {
  await database.sql`
    UPDATE execution_attempts
    SET state = 'failed', finished_at = now(), last_error = ${message.slice(0, 2000)}
    WHERE id = ${attemptId}::uuid AND state IN ('running', 'reconciling')
  `;
}

/** Records the intent to perform one external effect before it is attempted. */
export async function recordIntendedEffect(
  database: Database,
  input: { attemptId: string; runId: string; effectKind: EffectKind; idempotencyKey: string; request: unknown }
): Promise<OutboxRecord> {
  const [row] = await database.sql<{ id: string; state: OutboxState; external_id: string | null }[]>`
    INSERT INTO execution_outbox (id, attempt_id, run_id, effect_kind, idempotency_key, request_json, state)
    VALUES (${crypto.randomUUID()}::uuid, ${input.attemptId}::uuid, ${input.runId}::uuid, ${input.effectKind},
            ${input.idempotencyKey}, ${JSON.stringify(input.request)}::jsonb, 'pending')
    ON CONFLICT (idempotency_key) DO UPDATE SET last_error = execution_outbox.last_error
    RETURNING id, state, external_id
  `;
  if (!row) throw new Error("Unable to record the intended effect");
  return {
    id: row.id,
    attemptId: input.attemptId,
    runId: input.runId,
    effectKind: input.effectKind,
    idempotencyKey: input.idempotencyKey,
    request: input.request,
    state: row.state,
    externalId: row.external_id
  };
}

export async function markEffectDispatched(database: Database, outboxId: string): Promise<void> {
  await database.sql`
    UPDATE execution_outbox SET state = 'dispatched', dispatched_at = now()
    WHERE id = ${outboxId}::uuid AND state = 'pending'
  `;
}

export async function confirmEffect(database: Database, outboxId: string, externalId: string | null): Promise<void> {
  await database.sql`
    UPDATE execution_outbox SET state = 'confirmed', confirmed_at = now(), external_id = ${externalId}
    WHERE id = ${outboxId}::uuid AND state <> 'confirmed'
  `;
}

export async function abandonEffect(database: Database, outboxId: string, message: string): Promise<void> {
  await database.sql`
    UPDATE execution_outbox SET state = 'abandoned', last_error = ${message.slice(0, 2000)}
    WHERE id = ${outboxId}::uuid AND state <> 'confirmed'
  `;
}

export async function findEffect(database: Database, idempotencyKey: string): Promise<OutboxRecord | null> {
  const [row] = await database.sql<{
    id: string; attempt_id: string; run_id: string; effect_kind: EffectKind;
    request_json: unknown; state: OutboxState; external_id: string | null;
  }[]>`
    SELECT id, attempt_id, run_id, effect_kind, request_json, state, external_id
    FROM execution_outbox WHERE idempotency_key = ${idempotencyKey}
  `;
  if (!row) return null;
  return {
    id: row.id,
    attemptId: row.attempt_id,
    runId: row.run_id,
    effectKind: row.effect_kind,
    idempotencyKey,
    request: row.request_json,
    state: row.state,
    externalId: row.external_id
  };
}

/** Every effect an attempt intended, so reconciliation can ask "did this actually happen?". */
export async function listAttemptEffects(database: Database, attemptId: string): Promise<OutboxRecord[]> {
  const rows = await database.sql<{
    id: string; run_id: string; effect_kind: EffectKind; idempotency_key: string;
    request_json: unknown; state: OutboxState; external_id: string | null;
  }[]>`
    SELECT id, run_id, effect_kind, idempotency_key, request_json, state, external_id
    FROM execution_outbox WHERE attempt_id = ${attemptId}::uuid ORDER BY created_at
  `;
  return rows.map((row) => ({
    id: row.id,
    attemptId,
    runId: row.run_id,
    effectKind: row.effect_kind,
    idempotencyKey: row.idempotency_key,
    request: row.request_json,
    state: row.state,
    externalId: row.external_id
  }));
}
