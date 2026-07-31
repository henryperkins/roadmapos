import { z } from "zod";
import {
  ActionKindSchema,
  BoundarySchema,
  ConditionSchema,
  JudgmentDecisionSchema,
  PlanRelationshipSchema,
  type RepositoryPermissionSchema
} from "./enums.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CommitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const IsoDateSchema = z.string().datetime({ offset: true });
const CheckpointActionKindSchema = z.union([ActionKindSchema, z.literal("plan_revision")]);

export const ExecutionPlanDraftSchema = z.object({
  problemInterpretation: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  expectedPublicBehavior: z.array(z.string().min(1)),
  implementationSteps: z.array(z.string().min(1)).min(1),
  anticipatedPaths: z.array(z.string().min(1)),
  dependencies: z.array(z.string().min(1)),
  protectedZoneExpectations: z.array(z.string().min(1)),
  verificationCommandIds: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string().min(1)),
  rollback: z.string().min(1)
});
export type ExecutionPlanDraft = z.infer<typeof ExecutionPlanDraftSchema>;

export const ActionProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("read_files"),
    paths: z.array(z.string().min(1)).min(1).max(20),
    purpose: z.string().min(1)
  }),
  z.object({
    kind: z.literal("apply_patch"),
    patch: z.string().min(1),
    summary: z.string().min(1),
    affectedPaths: z.array(z.string().min(1)).min(1),
    discoveredFacts: z.array(z.string().min(1)),
    changesPublicInterface: z.boolean(),
    changesDependencies: z.boolean(),
    changesSecurityBehavior: z.boolean()
  }),
  z.object({
    kind: z.literal("run_validation"),
    commandId: z.string().min(1),
    reason: z.string().min(1)
  }),
  z.object({
    kind: z.literal("commit_and_push"),
    message: z.string().min(1),
    summary: z.string().min(1)
  }),
  z.object({
    kind: z.literal("open_draft_pr"),
    title: z.string().min(1),
    body: z.string().min(1)
  }),
  z.object({
    kind: z.literal("finish"),
    summary: z.string().min(1),
    knownLimitations: z.array(z.string())
  })
]);
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const PolicyEvaluationSnapshotSchema = z.object({
  boundary: BoundarySchema,
  requiresEscalation: z.boolean(),
  matchedRules: z.array(z.string().min(1))
});
export type PolicyEvaluationSnapshot = z.infer<typeof PolicyEvaluationSnapshotSchema>;

export const CheckpointPackageSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.object({
    owner: z.string().min(1),
    name: z.string().min(1),
    baseSha: CommitShaSchema
  }),
  policyHash: Sha256Schema,
  authorization: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("execution_plan"), version: z.number().int().positive(), contentHash: Sha256Schema }),
    z.object({ kind: z.literal("explicit_instruction"), version: z.number().int().positive(), contentHash: Sha256Schema })
  ]),
  policyEvaluation: PolicyEvaluationSnapshotSchema.optional(),
  contemplatedAction: z.object({
    kind: CheckpointActionKindSchema,
    summary: z.string().min(1),
    affectedPaths: z.array(z.string()),
    patchHash: Sha256Schema.optional(),
    validationCommandId: z.string().optional()
  }),
  discoveredFacts: z.array(z.string()),
  validationState: z.object({
    completedCommandIds: z.array(z.string()),
    failingCommandIds: z.array(z.string())
  }),
  reversible: z.boolean(),
  createdAt: IsoDateSchema
});
export type CheckpointPackage = z.infer<typeof CheckpointPackageSchema>;

/**
 * The plain object shape of a judgment classification, without the cross-field boundary rules.
 * Structured-output providers can only be handed an object schema, so this is what the model sees;
 * `JudgmentClassificationSchema` below remains the authoritative parser for every recorded value.
 */
export const JudgmentClassificationObjectSchema = z.object({
  boundary: BoundarySchema,
  planRelationship: PlanRelationshipSchema,
  decision: JudgmentDecisionSchema,
  affectedPolicyRules: z.array(z.string()),
  facts: z.array(z.string().min(1)).min(1),
  requiredDisclosureFields: z.array(z.string()),
  reversible: z.boolean(),
  confidence: z.number().int().min(0).max(100)
});

export const JudgmentClassificationSchema = JudgmentClassificationObjectSchema.superRefine((value, context) => {
  if (value.boundary === "platform_hard_stop" && value.decision !== "stop") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"], message: "Platform hard stops require stop" });
  }
  if (value.boundary === "repository_protected" && value.decision === "continue") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"], message: "Repository-protected boundaries require pause or stop" });
  }
});
export type JudgmentClassification = z.infer<typeof JudgmentClassificationSchema>;

export const PlanGenerationInputSchema = z.object({
  repositoryId: z.string().uuid(),
  issueNumber: z.number().int().positive(),
  baseSha: CommitShaSchema,
  policyHash: Sha256Schema,
  roadmapItem: z.object({ title: z.string(), body: z.string(), acceptanceCriteria: z.array(z.string()) }),
  repositoryContext: z.array(z.object({ path: z.string(), content: z.string() }))
});
export type PlanGenerationInput = z.infer<typeof PlanGenerationInputSchema>;

export const ActionContextSchema = z.object({
  runId: z.string().uuid(),
  condition: ConditionSchema,
  authorizationText: z.string().min(1),
  transcript: z.array(z.object({ role: z.enum(["agent", "system", "maintainer", "operator", "tool"]), content: z.string() })),
  readablePaths: z.array(z.string()),
  validationCommandIds: z.array(z.string())
});
export type ActionContext = z.infer<typeof ActionContextSchema>;

export type RepositoryPermission = z.infer<typeof RepositoryPermissionSchema>;
