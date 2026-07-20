import { sha256Canonical } from "@roadmapos/domain";
import type Postgres from "postgres";
import type { Database } from "./client.js";

export interface AuditEventInput {
  pilotId: string;
  eventType: string;
  actorType: "system" | "agent" | "maintainer" | "operator" | "auditor" | "github";
  actorId: string;
  payload: unknown;
}

export interface AuditEventRecord {
  id: string;
  sequence: number;
  previousHash: string | null;
  eventHash: string;
  createdAt: string;
}

// postgres's `begin` is overloaded, so `Parameters<...begin>[0]` resolves to the string-options
// overload rather than the callback. Reference the exported transaction type directly instead.
export type SqlTransaction = Postgres.TransactionSql;

export async function appendAuditEventTx(transaction: SqlTransaction, input: AuditEventInput): Promise<AuditEventRecord> {
  await transaction`SELECT pg_advisory_xact_lock(hashtext(${input.pilotId}))`;
  const [previous] = await transaction<{ sequence: number; event_hash: string }[]>`
    SELECT sequence, event_hash
    FROM pilot_events
    WHERE pilot_id = ${input.pilotId}::uuid
    ORDER BY sequence DESC
    LIMIT 1
  `;
  const sequence = (previous?.sequence ?? 0) + 1;
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const previousHash = previous?.event_hash ?? null;
  const eventHash = sha256Canonical({
    id,
    pilotId: input.pilotId,
    sequence,
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId,
    payload: input.payload,
    previousHash,
    createdAt
  });
  await transaction`
    INSERT INTO pilot_events
      (id, pilot_id, sequence, event_type, actor_type, actor_id, payload, previous_hash, event_hash, created_at)
    VALUES
      (${id}::uuid, ${input.pilotId}::uuid, ${sequence}, ${input.eventType}, ${input.actorType},
       ${input.actorId}, ${JSON.stringify(input.payload)}::jsonb, ${previousHash}, ${eventHash}, ${createdAt}::timestamptz)
  `;
  return { id, sequence, previousHash, eventHash, createdAt };
}

export async function appendAuditEvent(database: Database, input: AuditEventInput): Promise<AuditEventRecord> {
  return database.sql.begin((transaction) => appendAuditEventTx(transaction, input));
}
