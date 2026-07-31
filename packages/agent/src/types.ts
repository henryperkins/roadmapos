import type {
  ActionContext,
  ActionProposal,
  CheckpointPackage,
  ExecutionPlanDraft,
  JudgmentClassification,
  PlanGenerationInput
} from "@roadmapos/domain";

export interface AgentResult<T> {
  value: T;
  requestHash: string;
  outputHash: string;
  providerTraceId: string | null;
}

export interface AgentGateway {
  generatePlan(input: PlanGenerationInput): Promise<AgentResult<ExecutionPlanDraft>>;
  proposeNextAction(input: ActionContext): Promise<AgentResult<ActionProposal>>;
  classifyCheckpoint(input: CheckpointPackage): Promise<AgentResult<JudgmentClassification>>;
}
