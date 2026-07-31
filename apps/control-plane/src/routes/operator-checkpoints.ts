import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { governanceCheckpoints, runs, type Database } from "@roadmapos/db";
import { JudgmentClassificationObjectSchema, JudgmentClassificationSchema } from "@roadmapos/domain";
import { z } from "zod";
import { requireParticipant } from "../auth.js";
import type { CheckpointService } from "../services/checkpoint-service.js";
import type { CheckpointFollowUpService } from "../services/checkpoint-followup.js";

/**
 * A checkpoint belongs to exactly one pilot. An operator bound to a different pilot is refused
 * before the frozen package is disclosed, so one pilot's evidence is never readable — or
 * classifiable — from another pilot's session.
 */
async function assertSamePilot(database: Database, checkpointId: string, pilotId: string): Promise<void> {
  const [row] = await database.db
    .select({ pilotId: runs.pilotId })
    .from(governanceCheckpoints)
    .innerJoin(runs, eq(runs.id, governanceCheckpoints.runId))
    .where(eq(governanceCheckpoints.id, checkpointId));
  if (!row) {
    const error = new Error("not_found") as Error & { statusCode: number };
    error.statusCode = 404;
    throw error;
  }
  if (row.pilotId !== pilotId) {
    const error = new Error("forbidden") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
}

export async function registerOperatorCheckpointRoutes(
  app: FastifyInstance,
  database: Database,
  service: CheckpointService,
  followUp?: CheckpointFollowUpService
): Promise<void> {
  app.get("/internal/operator/checkpoints/:checkpointId", async (request) => {
    const operator = requireParticipant(request, "operator");
    const { checkpointId } = z.object({ checkpointId: z.string().uuid() }).parse(request.params);
    await assertSamePilot(database, checkpointId, operator.pilotId);
    return service.getOperatorView(checkpointId);
  });

  app.post("/internal/operator/checkpoints/:checkpointId/classification", async (request, reply) => {
    const operator = requireParticipant(request, "operator");
    const { checkpointId } = z.object({ checkpointId: z.string().uuid() }).parse(request.params);
    await assertSamePilot(database, checkpointId, operator.pilotId);
    const { rationale, ...fields } = JudgmentClassificationObjectSchema.extend({ rationale: z.string().min(1) }).parse(request.body);
    const classification = JudgmentClassificationSchema.parse(fields);
    const result = await service.recordOperatorClassification({
      checkpointId,
      classification,
      rationale,
      operatorId: operator.participantId
    });
    await followUp?.dispatch(checkpointId, result, operator.participantId);
    return reply.code(201).send(result);
  });
}
