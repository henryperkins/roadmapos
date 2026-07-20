import { describe, expect, it } from "vitest";
import {
  ActionProposalSchema,
  CheckpointPackageSchema,
  JudgmentClassificationSchema
} from "../src/index.js";

describe("domain schemas", () => {
  it("rejects a raw shell command proposed by the agent", () => {
    expect(() => ActionProposalSchema.parse({ kind: "shell", command: "rm -rf /" })).toThrow();
  });

  it("requires facts, reversibility, and confidence for a classification", () => {
    expect(() => JudgmentClassificationSchema.parse({ decision: "continue" })).toThrow();
  });

  it("enforces protected-boundary decisions independently of prompts", () => {
    const base = {
      planRelationship: "within_plan" as const,
      affectedPolicyRules: ["platform:merge"],
      facts: ["The action crosses a non-overridable platform boundary"],
      requiredDisclosureFields: [],
      reversible: false,
      confidence: 99
    };
    expect(() => JudgmentClassificationSchema.parse({ ...base, boundary: "platform_hard_stop", decision: "continue" })).toThrow("Platform hard stops require stop");
    expect(() => JudgmentClassificationSchema.parse({ ...base, boundary: "platform_hard_stop", decision: "pause_and_escalate" })).toThrow("Platform hard stops require stop");
    expect(() => JudgmentClassificationSchema.parse({ ...base, boundary: "repository_protected", decision: "continue" })).toThrow("Repository-protected boundaries require pause or stop");
  });

  it("accepts a frozen checkpoint package with a contemplated patch", () => {
    const result = CheckpointPackageSchema.parse({
      schemaVersion: 1,
      repository: { owner: "acme", name: "widget", baseSha: "a".repeat(40) },
      policyHash: "b".repeat(64),
      authorization: { kind: "execution_plan", version: 2, contentHash: "c".repeat(64) },
      policyEvaluation: {
        boundary: "repository_protected",
        requiresEscalation: true,
        matchedRules: ["protected_zone:src/parser.ts"]
      },
      contemplatedAction: {
        kind: "apply_patch",
        summary: "Update parser behavior",
        affectedPaths: ["src/parser.ts"],
        patchHash: "d".repeat(64)
      },
      discoveredFacts: ["Existing parser accepts empty input"],
      validationState: { completedCommandIds: [], failingCommandIds: [] },
      reversible: true,
      createdAt: "2026-07-20T12:00:00.000Z"
    });
    expect(result.schemaVersion).toBe(1);
  });

  it("accepts plan revision as a checkpoint-only action kind", () => {
    const result = CheckpointPackageSchema.parse({
      schemaVersion: 1,
      repository: { owner: "acme", name: "widget", baseSha: "a".repeat(40) },
      policyHash: "b".repeat(64),
      authorization: { kind: "execution_plan", version: 2, contentHash: "c".repeat(64) },
      contemplatedAction: { kind: "plan_revision", summary: "Revise approved plan", affectedPaths: [] },
      discoveredFacts: ["Acceptance criterion changed"],
      validationState: { completedCommandIds: [], failingCommandIds: [] },
      reversible: true,
      createdAt: "2026-07-20T12:00:00.000Z"
    });
    expect(result.contemplatedAction.kind).toBe("plan_revision");
  });
});
