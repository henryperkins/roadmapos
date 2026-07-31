import { z } from "zod";

export const RunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("analysis_started") }),
  z.object({ type: z.literal("plan_published") }),
  z.object({ type: z.literal("plan_quorum_reached") }),
  z.object({ type: z.literal("plan_quorum_lost") }),
  z.object({ type: z.literal("plan_quorum_restored_pending_escalation") }),
  z.object({ type: z.literal("plan_quorum_restored_authorized_action") }),
  z.object({ type: z.literal("instruction_received") }),
  z.object({ type: z.literal("action_proposed") }),
  z.object({ type: z.literal("nonconsequential_action_authorized") }),
  z.object({ type: z.literal("operator_checkpoint_frozen") }),
  z.object({ type: z.literal("plan_revision_frozen") }),
  z.object({ type: z.literal("operator_continue") }),
  z.object({ type: z.literal("operator_pause") }),
  z.object({ type: z.literal("operator_stop") }),
  z.object({ type: z.literal("editorial_revision_accepted") }),
  z.object({ type: z.literal("material_revision_requires_approval") }),
  z.object({ type: z.literal("action_completed") }),
  z.object({ type: z.literal("escalation_quorum_reached") }),
  z.object({ type: z.literal("escalation_quorum_lost") }),
  z.object({ type: z.literal("escalation_rejected") }),
  z.object({ type: z.literal("draft_pr_opened") }),
  z.object({ type: z.literal("review_ready_declared") }),
  z.object({ type: z.literal("endpoint_verified") }),
  z.object({ type: z.literal("endpoint_rejected") }),
  z.object({ type: z.literal("terminated") })
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
