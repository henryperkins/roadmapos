import { reduceRunState, sha256Canonical, type Condition, type RunEvent, type RunState } from "@roadmapos/domain";
import type { Database } from "./client.js";
import { appendAuditEventTx, type SqlTransaction } from "./audit-events.js";

export interface RunTransitionInput {
  runId: string;
  event: RunEvent;
  actorType: "system" | "agent" | "maintainer" | "operator" | "github";
  actorId: string;
}

export interface RunTransitionResult {
  previousState: RunState;
  state: RunState;
  pilotId: string;
  condition: Condition;
}

export class ExecutionRepository {
  constructor(private readonly database: Database) {}

  async transition(input: RunTransitionInput): Promise<RunState> {
    const result = await this.database.sql.begin((transaction) => this.transitionDetailedTx(transaction, input));
    return result.state;
  }

  async transitionTx(transaction: SqlTransaction, input: RunTransitionInput): Promise<RunState> {
    return (await this.transitionDetailedTx(transaction, input)).state;
  }

  /**
   * The pilot and the condition are read from the locked run row, never accepted from the caller.
   * A caller that could name them could attribute one run's governance event to another pilot, or
   * drive the reducer down the wrong condition's branch.
   */
  async transitionDetailedTx(transaction: SqlTransaction, input: RunTransitionInput): Promise<RunTransitionResult> {
    const [run] = await transaction<{ state: RunState; pilot_id: string; condition: Condition }[]>`
      SELECT state, pilot_id, condition
      FROM runs
      WHERE id = ${input.runId}::uuid
      FOR UPDATE
    `;
    if (!run) throw new Error("Run not found");
    const next = reduceRunState(run.state, input.event, run.condition);
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
      pilotId: run.pilot_id,
      eventType: `run.${input.event.type}`,
      actorType: input.actorType,
      actorId: input.actorId,
      payload: { runId: input.runId, previousState: run.state, nextState: next, event: input.event }
    });
    return { previousState: run.state, state: next, pilotId: run.pilot_id, condition: run.condition };
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
