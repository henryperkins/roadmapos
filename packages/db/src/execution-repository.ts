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
