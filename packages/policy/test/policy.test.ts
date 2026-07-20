import { describe, expect, it } from "vitest";
import { parseRepositoryPolicy } from "../src/index.js";

const source = `
version: 1
authorization:
  minimum_approval_role: maintain
  execution_plan_quorum: 1
  escalation_quorum: 1
protected_zones:
  - path: ".github/workflows/**"
    reason: "CI and release authority"
dependencies:
  additions_require_escalation: true
public_interfaces:
  changes_require_escalation: true
execution:
  readable_paths: ["**"]
  validation_commands:
    - id: unit
      argv: ["pnpm", "test"]
      timeout_seconds: 900
`;

describe("parseRepositoryPolicy", () => {
  it("parses the required authorization and execution controls", () => {
    const policy = parseRepositoryPolicy(source);
    expect(policy.authorization.minimumApprovalRole).toBe("maintain");
    expect(policy.execution.validationCommands[0]?.id).toBe("unit");
  });

  it("rejects zero quorum", () => {
    expect(() => parseRepositoryPolicy(source.replace("execution_plan_quorum: 1", "execution_plan_quorum: 0"))).toThrow();
  });

  it("rejects a policy that omits any required authorization key", () => {
    expect(() => parseRepositoryPolicy(source.replace("  escalation_quorum: 1\n", ""))).toThrow();
  });
});
