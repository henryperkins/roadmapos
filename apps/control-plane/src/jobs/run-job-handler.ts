import { z } from "zod";
import type { ActionCoordinator } from "../services/action-coordinator.js";

export const ProposeActionPayloadSchema = z.object({ runId: z.string().uuid() });
export const ExecuteActionPayloadSchema = z.object({ runId: z.string().uuid(), proposalId: z.string().uuid() });

export async function handleProposeAction(payload: unknown, coordinator: ActionCoordinator): Promise<void> {
  const { runId } = ProposeActionPayloadSchema.parse(payload);
  await coordinator.propose(runId);
}

export async function handleExecuteAction(payload: unknown, coordinator: ActionCoordinator): Promise<void> {
  const { runId, proposalId } = ExecuteActionPayloadSchema.parse(payload);
  await coordinator.executeAfterGate(runId, proposalId);
}
