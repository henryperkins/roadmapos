import { describe, expect, it } from "vitest";
import { DeterministicFakeAgentGateway } from "../src/index.js";
import type { CheckpointPackage } from "@roadmapos/domain";

function gateway(): DeterministicFakeAgentGateway {
  return new DeterministicFakeAgentGateway(
    {
      problemInterpretation: "Fix parser",
      acceptanceCriteria: ["Empty input is rejected"],
      expectedPublicBehavior: ["Invalid input returns an error"],
      implementationSteps: ["Patch parser", "Run tests"],
      anticipatedPaths: ["src/parser.ts"],
      dependencies: [],
      protectedZoneExpectations: [],
      verificationCommandIds: ["unit"],
      risks: ["Regression"],
      rollback: "Revert the commit"
    },
    [{ kind: "read_files", paths: ["src/parser.ts"], purpose: "Inspect implementation" }],
    () => ({ boundary: "none", planRelationship: "within_plan", decision: "continue", affectedPolicyRules: [], facts: ["Within plan"], requiredDisclosureFields: [], reversible: true, confidence: 95 })
  );
}

describe("DeterministicFakeAgentGateway", () => {
  it("returns fake actions in fixed order with hashes", async () => {
    const action = await gateway().proposeNextAction({} as never);
    expect(action.value.kind).toBe("read_files");
    expect(action.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(action.requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("exhausts its fixed action sequence rather than inventing one", async () => {
    const instance = gateway();
    await instance.proposeNextAction({} as never);
    await expect(instance.proposeNextAction({} as never)).rejects.toThrow("no remaining action");
  });

  it("refuses a classification that violates the boundary contract", async () => {
    const instance = new DeterministicFakeAgentGateway(
      gateway_plan(),
      [],
      () => ({ boundary: "platform_hard_stop", planRelationship: "within_plan", decision: "continue", affectedPolicyRules: [], facts: ["Override"], requiredDisclosureFields: [], reversible: false, confidence: 10 })
    );
    await expect(instance.classifyCheckpoint({} as unknown as CheckpointPackage)).rejects.toThrow("Platform hard stops require stop");
  });
});

function gateway_plan() {
  return {
    problemInterpretation: "Fix parser",
    acceptanceCriteria: ["Empty input is rejected"],
    expectedPublicBehavior: [],
    implementationSteps: ["Patch parser"],
    anticipatedPaths: [],
    dependencies: [],
    protectedZoneExpectations: [],
    verificationCommandIds: ["unit"],
    risks: [],
    rollback: "Revert"
  };
}
