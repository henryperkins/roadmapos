import { z } from "zod";
import YAML from "yaml";

const RawPolicySchema = z.object({
  version: z.literal(1),
  authorization: z.object({
    minimum_approval_role: z.enum(["write", "maintain", "admin"]),
    execution_plan_quorum: z.number().int().min(1),
    escalation_quorum: z.number().int().min(1)
  }),
  protected_zones: z.array(z.object({ path: z.string().min(1), reason: z.string().min(1) })).default([]),
  dependencies: z.object({ additions_require_escalation: z.boolean().default(true) }).default({}),
  public_interfaces: z.object({ changes_require_escalation: z.boolean().default(true) }).default({}),
  execution: z.object({
    readable_paths: z.array(z.string().min(1)).min(1),
    validation_commands: z.array(z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
      argv: z.array(z.string().min(1)).min(1),
      timeout_seconds: z.number().int().min(1).max(3600)
    })).min(1)
  })
});

export interface RepositoryPolicy {
  version: 1;
  authorization: {
    minimumApprovalRole: "write" | "maintain" | "admin";
    executionPlanQuorum: number;
    escalationQuorum: number;
  };
  protectedZones: Array<{ path: string; reason: string }>;
  dependencies: { additionsRequireEscalation: boolean };
  publicInterfaces: { changesRequireEscalation: boolean };
  execution: {
    readablePaths: string[];
    validationCommands: Array<{ id: string; argv: string[]; timeoutSeconds: number }>;
  };
}

// Portal-generated policy templates supply maintain/1/1, but committed policy files must state all three keys explicitly.
export function parseRepositoryPolicy(source: string): RepositoryPolicy {
  const raw = RawPolicySchema.parse(YAML.parse(source));
  return {
    version: 1,
    authorization: {
      minimumApprovalRole: raw.authorization.minimum_approval_role,
      executionPlanQuorum: raw.authorization.execution_plan_quorum,
      escalationQuorum: raw.authorization.escalation_quorum
    },
    protectedZones: raw.protected_zones,
    dependencies: { additionsRequireEscalation: raw.dependencies.additions_require_escalation },
    publicInterfaces: { changesRequireEscalation: raw.public_interfaces.changes_require_escalation },
    execution: {
      readablePaths: raw.execution.readable_paths,
      validationCommands: raw.execution.validation_commands.map((command) => ({
        id: command.id,
        argv: command.argv,
        timeoutSeconds: command.timeout_seconds
      }))
    }
  };
}
