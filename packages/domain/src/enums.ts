import { z } from "zod";

export const ConditionSchema = z.enum(["interactive_copilot", "governed_orchestration"]);
export type Condition = z.infer<typeof ConditionSchema>;

export const RunStateSchema = z.enum([
  "registered",
  "planning",
  "awaiting_plan_approval",
  "awaiting_instruction",
  "proposing_action",
  "awaiting_operator_gate",
  "awaiting_escalation_approval",
  "executing_action",
  "awaiting_review_ready",
  "verifying_endpoint",
  "completed",
  "terminated"
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const ActionKindSchema = z.enum([
  "read_files",
  "apply_patch",
  "run_validation",
  "commit_and_push",
  "open_draft_pr",
  "finish"
]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const BoundarySchema = z.enum(["none", "repository_protected", "platform_hard_stop"]);
export type Boundary = z.infer<typeof BoundarySchema>;
export const PlanRelationshipSchema = z.enum([
  "within_plan",
  "editorial_only",
  "materially_equivalent_variation",
  "material_scope_expansion",
  "plan_invalidating_change",
  "requirement_conflict",
  "verification_blocked"
]);
export type PlanRelationship = z.infer<typeof PlanRelationshipSchema>;
export const JudgmentDecisionSchema = z.enum(["continue", "pause_and_escalate", "stop"]);
export type JudgmentDecision = z.infer<typeof JudgmentDecisionSchema>;
export const RepositoryPermissionSchema = z.enum(["none", "read", "triage", "write", "maintain", "admin"]);
export const EffortBandSchema = z.enum(["under_30", "30_to_60", "61_to_120", "over_120"]);
export type EffortBand = z.infer<typeof EffortBandSchema>;
export const QualityOutcomeSchema = z.enum(["acceptable", "major_rework", "rejected_or_abandoned"]);
export type QualityOutcome = z.infer<typeof QualityOutcomeSchema>;
export const IncidentSeveritySchema = z.enum(["minor", "major", "critical"]);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;
export const InterventionCategorySchema = z.enum([
  "safety_prevention",
  "requirement_correction",
  "repository_context_correction",
  "implementation_correction",
  "tool_environment_recovery",
  "administrative_support"
]);
export type InterventionCategory = z.infer<typeof InterventionCategorySchema>;
