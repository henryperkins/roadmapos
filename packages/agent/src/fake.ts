import {
  ActionProposalSchema,
  ExecutionPlanDraftSchema,
  JudgmentClassificationSchema,
  sha256Canonical,
  type ActionContext,
  type ActionProposal,
  type CheckpointPackage,
  type ExecutionPlanDraft,
  type JudgmentClassification,
  type PlanGenerationInput
} from "@roadmapos/domain";
import type { AgentGateway, AgentResult } from "./types.js";

function result<T>(value: T): AgentResult<T> {
  return { value, requestHash: sha256Canonical({ fixture: value }), outputHash: sha256Canonical(value), providerTraceId: "fixture" };
}

/**
 * Replays a fixed plan, a fixed action sequence, and a pure classifier. Every artifact still passes
 * the same Zod contract the provider gateway enforces, so a fixture can never smuggle a shape the
 * production path would have rejected.
 */
export class DeterministicFakeAgentGateway implements AgentGateway {
  private actionIndex = 0;

  constructor(
    private readonly plan: ExecutionPlanDraft,
    private readonly actions: ActionProposal[],
    private readonly classifier: (input: CheckpointPackage) => JudgmentClassification
  ) {}

  async generatePlan(_input: PlanGenerationInput): Promise<AgentResult<ExecutionPlanDraft>> {
    return result(ExecutionPlanDraftSchema.parse(this.plan));
  }

  async proposeNextAction(_input: ActionContext): Promise<AgentResult<ActionProposal>> {
    const action = this.actions[this.actionIndex++];
    if (!action) throw new Error("Fake agent has no remaining action");
    return result(ActionProposalSchema.parse(action));
  }

  async classifyCheckpoint(input: CheckpointPackage): Promise<AgentResult<JudgmentClassification>> {
    return result(JudgmentClassificationSchema.parse(this.classifier(input)));
  }
}
