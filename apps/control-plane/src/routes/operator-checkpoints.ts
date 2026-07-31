import type { FastifyInstance } from "fastify";
import { JudgmentClassificationObjectSchema, JudgmentClassificationSchema } from "@roadmapos/domain";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { CheckpointService } from "../services/checkpoint-service.js";
import type { CheckpointFollowUpService } from "../services/checkpoint-followup.js";

export async function registerOperatorCheckpointRoutes(
  app: FastifyInstance,
  service: CheckpointService,
  followUp?: CheckpointFollowUpService
): Promise<void> {
  app.get("/internal/operator/checkpoints/:checkpointId", async (request) => {
    requireRole(request, "operator");
    const { checkpointId } = z.object({ checkpointId: z.string().uuid() }).parse(request.params);
    return service.getOperatorView(checkpointId);
  });

  app.post("/internal/operator/checkpoints/:checkpointId/classification", async (request, reply) => {
    requireRole(request, "operator");
    const { checkpointId } = z.object({ checkpointId: z.string().uuid() }).parse(request.params);
    const { rationale, ...fields } = JudgmentClassificationObjectSchema.extend({ rationale: z.string().min(1) }).parse(request.body);
    const classification = JudgmentClassificationSchema.parse(fields);
    const operatorId = "operator";
    const result = await service.recordOperatorClassification({ checkpointId, classification, rationale, operatorId });
    await followUp?.dispatch(checkpointId, result, operatorId);
    return reply.code(201).send(result);
  });
}
