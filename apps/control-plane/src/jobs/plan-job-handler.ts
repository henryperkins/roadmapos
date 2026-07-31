import { z } from "zod";
import type { PlanService } from "../services/plan-service.js";

export const RunJobPayloadSchema = z.object({ runId: z.string().uuid() });

export async function handlePlanGenerate(payload: unknown, planService: PlanService): Promise<void> {
  const { runId } = RunJobPayloadSchema.parse(payload);
  await planService.generateInitialPlan(runId);
}
