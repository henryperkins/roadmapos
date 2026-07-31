import { describe, expect, it } from "vitest";
import { DeviationDisclosureSchema, EscalationRequestSchema } from "../src/index.js";

const escalation = {
  approvedPlanVersion: 1,
  discovered: ["The patch touches a protected zone"],
  differenceFromAuthorization: "material_scope_expansion",
  necessity: "Reject empty parser input",
  affectedPaths: ["src/auth/session.ts"],
  affectedDependencies: [],
  affectedInterfaces: [],
  protectedZones: ["protected_zone:src/auth/**"],
  alternatives: [
    { label: "Approve this exact escalation", consequence: "The operator may execute the frozen action only." },
    { label: "Stop the run", consequence: "No further repository writes occur." }
  ],
  recommendation: "Pause for maintainer review",
  approvalConsequence: "The frozen action becomes eligible for execution.",
  rejectionConsequence: "The frozen action remains unexecuted.",
  reversible: true,
  confidence: 90,
  evidence: ["The patch changes authentication behavior"]
};

describe("EscalationRequestSchema", () => {
  it("accepts a complete escalation", () => {
    expect(EscalationRequestSchema.parse(escalation).alternatives).toHaveLength(2);
  });

  it("rejects an escalation with no stopping alternative", () => {
    expect(() => EscalationRequestSchema.parse({ ...escalation, alternatives: [escalation.alternatives[0]] })).toThrow();
  });

  it("rejects an escalation with no evidence", () => {
    expect(() => EscalationRequestSchema.parse({ ...escalation, evidence: [] })).toThrow();
  });
});

const deviation = {
  originalPlanExpectation: "src/parser.ts",
  actualImplementationVariation: "Also updated the shared sanitizer",
  continueWithoutEscalationReason: "The behavior remains within approved intent",
  additionalFiles: ["src/sanitizer.ts"],
  additionalDependencies: [],
  reversible: true,
  evidence: ["The sanitizer is the only shared entry point"],
  confidence: 88
};

describe("DeviationDisclosureSchema", () => {
  it("accepts a complete disclosure", () => {
    expect(DeviationDisclosureSchema.parse(deviation).additionalFiles).toEqual(["src/sanitizer.ts"]);
  });

  it("rejects a deviation with no evidence", () => {
    expect(() => DeviationDisclosureSchema.parse({ ...deviation, evidence: [] })).toThrow();
  });
});
