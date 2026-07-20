import { describe, expect, it } from "vitest";
import { buildEffectivePolicy, evaluateAction, parseRepositoryPolicy } from "../src/index.js";

const policy = buildEffectivePolicy(parseRepositoryPolicy(`
version: 1
authorization:
  minimum_approval_role: maintain
  execution_plan_quorum: 1
  escalation_quorum: 1
protected_zones:
  - path: "src/auth/**"
    reason: "Authentication behavior"
dependencies:
  additions_require_escalation: true
public_interfaces:
  changes_require_escalation: true
execution:
  readable_paths: ["src/**", "test/**", "package.json"]
  validation_commands:
    - id: unit
      argv: ["pnpm", "test"]
      timeout_seconds: 900
`), { branchProtectionEnabled: true, requiredApprovals: 1 });

describe("evaluateAction", () => {
  it("requires escalation for a protected path", () => {
    const result = evaluateAction(policy, {
      kind: "apply_patch",
      patch: "diff --git a/src/auth/session.ts b/src/auth/session.ts",
      summary: "Change session handling",
      affectedPaths: ["src/auth/session.ts"],
      discoveredFacts: [],
      changesPublicInterface: false,
      changesDependencies: false,
      changesSecurityBehavior: true
    });
    expect(result.boundary).toBe("repository_protected");
    expect(result.requiresEscalation).toBe(true);
  });

  it("hard-stops any unsupported consequential action kind", () => {
    expect(evaluateAction(policy, { kind: "merge" } as never).boundary).toBe("platform_hard_stop");
  });
});
