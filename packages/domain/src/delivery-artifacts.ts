import { z } from "zod";

export const EscalationRequestSchema = z.object({
  approvedPlanVersion: z.number().int().positive().nullable(),
  discovered: z.array(z.string().min(1)).min(1),
  differenceFromAuthorization: z.string().min(1),
  necessity: z.string().min(1),
  affectedPaths: z.array(z.string()),
  affectedDependencies: z.array(z.string()),
  affectedInterfaces: z.array(z.string()),
  protectedZones: z.array(z.string()),
  alternatives: z.array(z.object({ label: z.string().min(1), consequence: z.string().min(1) })).min(2),
  recommendation: z.string().min(1),
  approvalConsequence: z.string().min(1),
  rejectionConsequence: z.string().min(1),
  reversible: z.boolean(),
  confidence: z.number().int().min(0).max(100),
  evidence: z.array(z.string().min(1)).min(1)
});
export type EscalationRequest = z.infer<typeof EscalationRequestSchema>;

export const DeviationDisclosureSchema = z.object({
  originalPlanExpectation: z.string().min(1),
  actualImplementationVariation: z.string().min(1),
  continueWithoutEscalationReason: z.string().min(1),
  additionalFiles: z.array(z.string()),
  additionalDependencies: z.array(z.string()),
  reversible: z.boolean(),
  evidence: z.array(z.string().min(1)).min(1),
  confidence: z.number().int().min(0).max(100)
});
export type DeviationDisclosure = z.infer<typeof DeviationDisclosureSchema>;
