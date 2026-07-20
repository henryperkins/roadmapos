import type { Database } from "./client.js";

export async function enqueueJob(database: Database, jobType: string, payload: unknown): Promise<string> {
  const id = crypto.randomUUID();
  await database.sql`
    INSERT INTO jobs (id, job_type, payload)
    VALUES (${id}::uuid, ${jobType}, ${JSON.stringify(payload)}::jsonb)
  `;
  return id;
}

export async function claimNextJob(database: Database, workerId: string, allowedTypes: string[]) {
  if (allowedTypes.length === 0) return null;
  return database.sql.begin(async (transaction) => {
    const [job] = await transaction<{
      id: string;
      job_type: string;
      payload: unknown;
      attempts: number;
      max_attempts: number;
    }[]>`
      SELECT id, job_type, payload, attempts, max_attempts
      FROM jobs
      WHERE status = 'queued'
        AND available_at <= now()
        AND job_type = ANY(${allowedTypes})
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (!job) return null;
    await transaction`
      UPDATE jobs
      SET status = 'running', locked_by = ${workerId}, locked_at = now(), attempts = attempts + 1
      WHERE id = ${job.id}::uuid
    `;
    return { id: job.id, jobType: job.job_type, payload: job.payload, attempt: job.attempts + 1, maxAttempts: job.max_attempts };
  });
}

export async function completeJob(database: Database, jobId: string): Promise<void> {
  await database.sql`UPDATE jobs SET status = 'complete', completed_at = now() WHERE id = ${jobId}::uuid`;
}

export async function failJob(database: Database, jobId: string, message: string, retryAt: Date | null): Promise<void> {
  await database.sql`
    UPDATE jobs
    SET status = CASE WHEN ${retryAt?.toISOString() ?? null}::timestamptz IS NULL THEN 'failed' ELSE 'queued' END,
        available_at = COALESCE(${retryAt?.toISOString() ?? null}::timestamptz, available_at),
        locked_by = NULL,
        locked_at = NULL,
        last_error = ${message}
    WHERE id = ${jobId}::uuid
  `;
}
