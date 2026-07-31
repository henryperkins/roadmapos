import type { Condition, RunState } from "./enums.js";
import type { RunEvent } from "./run-events.js";

const transitions: Record<RunState, Partial<Record<RunEvent["type"], RunState>>> = {
  registered: { analysis_started: "planning", terminated: "terminated" },
  planning: { plan_published: "awaiting_plan_approval", instruction_received: "proposing_action", terminated: "terminated" },
  awaiting_plan_approval: {
    plan_quorum_reached: "proposing_action",
    plan_quorum_restored_pending_escalation: "awaiting_escalation_approval",
    plan_quorum_restored_authorized_action: "executing_action",
    plan_revision_frozen: "awaiting_operator_gate",
    terminated: "terminated"
  },
  awaiting_instruction: { instruction_received: "proposing_action", terminated: "terminated" },
  proposing_action: {
    action_proposed: "awaiting_operator_gate",
    nonconsequential_action_authorized: "executing_action",
    operator_checkpoint_frozen: "awaiting_operator_gate",
    plan_revision_frozen: "awaiting_operator_gate",
    plan_quorum_lost: "awaiting_plan_approval",
    terminated: "terminated"
  },
  awaiting_operator_gate: {
    operator_continue: "executing_action",
    operator_pause: "awaiting_escalation_approval",
    operator_stop: "terminated",
    editorial_revision_accepted: "proposing_action",
    material_revision_requires_approval: "awaiting_plan_approval",
    plan_quorum_lost: "awaiting_plan_approval",
    terminated: "terminated"
  },
  awaiting_escalation_approval: {
    escalation_quorum_reached: "executing_action",
    escalation_rejected: "proposing_action",
    plan_quorum_lost: "awaiting_plan_approval",
    terminated: "terminated"
  },
  executing_action: {
    action_completed: "proposing_action",
    draft_pr_opened: "awaiting_review_ready",
    plan_quorum_lost: "awaiting_plan_approval",
    escalation_quorum_lost: "awaiting_escalation_approval",
    terminated: "terminated"
  },
  awaiting_review_ready: { review_ready_declared: "verifying_endpoint", terminated: "terminated" },
  verifying_endpoint: { endpoint_verified: "completed", endpoint_rejected: "awaiting_review_ready", terminated: "terminated" },
  completed: {},
  terminated: {}
};

export function reduceRunState(current: RunState, event: RunEvent, condition: Condition): RunState {
  if (current === "registered" && event.type === "analysis_started" && condition === "interactive_copilot") {
    return "awaiting_instruction";
  }
  if (current === "planning" && event.type === "instruction_received" && condition !== "interactive_copilot") {
    throw new Error("Invalid run transition: only interactive copilot accepts an instruction from planning");
  }
  if (current === "executing_action" && event.type === "action_completed") {
    return condition === "interactive_copilot" ? "awaiting_instruction" : "proposing_action";
  }
  if (current === "awaiting_escalation_approval" && event.type === "escalation_rejected" && condition === "interactive_copilot") {
    return "awaiting_instruction";
  }
  const next = transitions[current][event.type];
  if (!next) throw new Error(`Invalid run transition: ${current} + ${event.type}`);
  return next;
}
