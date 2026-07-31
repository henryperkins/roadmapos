import {
  ActionContextSchema,
  ActionProposalSchema,
  CheckpointPackageSchema,
  ExecutionPlanDraftSchema,
  JudgmentClassificationObjectSchema,
  JudgmentClassificationSchema,
  PlanGenerationInputSchema,
  canonicalJson,
  sha256Canonical,
  type ActionContext,
  type ActionProposal,
  type CheckpointPackage,
  type ExecutionPlanDraft,
  type JudgmentClassification,
  type PlanGenerationInput
} from "@roadmapos/domain";
import { z, type ZodObject, type ZodRawShape } from "zod";
import type { AgentGateway, AgentResult } from "./types.js";
import { ACTION_INSTRUCTIONS, CLASSIFIER_INSTRUCTIONS, PLANNER_INSTRUCTIONS } from "./prompts.js";
import { assertPromptSafe } from "./prompt-safety.js";
import { runStructured } from "./openai-runner.js";

/**
 * `ActionProposalSchema` is a discriminated union, which a structured-output provider cannot take
 * as a top-level schema. The model answers with a single-key envelope and the union stays the
 * authoritative parser for the value inside it.
 */
const ActionProposalEnvelopeSchema = z.object({ action: ActionProposalSchema });

export class OpenAIAgentGateway implements AgentGateway {
  constructor(private readonly model: string) {}

  private async execute<T>(input: {
    name: string;
    instructions: string;
    outputType: ZodObject<ZodRawShape>;
    parse: (value: unknown) => T;
    value: unknown;
  }): Promise<AgentResult<T>> {
    const prompt = canonicalJson(input.value);
    assertPromptSafe(prompt);
    const result = await runStructured({
      name: input.name,
      model: this.model,
      instructions: input.instructions,
      outputType: input.outputType,
      parse: input.parse,
      prompt
    });
    return {
      value: result.value,
      requestHash: sha256Canonical(input.value),
      outputHash: sha256Canonical(result.value),
      providerTraceId: result.traceId
    };
  }

  generatePlan(input: PlanGenerationInput): Promise<AgentResult<ExecutionPlanDraft>> {
    return this.execute({
      name: "RoadmapOS Planner",
      instructions: PLANNER_INSTRUCTIONS,
      outputType: ExecutionPlanDraftSchema,
      parse: (value) => ExecutionPlanDraftSchema.parse(value),
      value: PlanGenerationInputSchema.parse(input)
    });
  }

  proposeNextAction(input: ActionContext): Promise<AgentResult<ActionProposal>> {
    return this.execute({
      name: "RoadmapOS Action Proposer",
      instructions: ACTION_INSTRUCTIONS,
      outputType: ActionProposalEnvelopeSchema,
      parse: (value) => ActionProposalEnvelopeSchema.parse(value).action,
      value: ActionContextSchema.parse(input)
    });
  }

  classifyCheckpoint(input: CheckpointPackage): Promise<AgentResult<JudgmentClassification>> {
    return this.execute({
      name: "RoadmapOS Governance Classifier",
      instructions: CLASSIFIER_INSTRUCTIONS,
      outputType: JudgmentClassificationObjectSchema,
      parse: (value) => JudgmentClassificationSchema.parse(value),
      value: CheckpointPackageSchema.parse(input)
    });
  }
}
