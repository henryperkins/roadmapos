import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointForm } from "../app/operator/checkpoints/[checkpointId]/checkpoint-form.js";

afterEach(cleanup);

const pageDirectory = join(process.env.PORTAL_ROOT ?? process.cwd(), "app", "operator", "checkpoints", "[checkpointId]");

const frozenPackage = {
  schemaVersion: 1,
  repository: { owner: "acme", name: "widget", baseSha: "a".repeat(40) },
  policyEvaluation: { boundary: "repository_protected", requiresEscalation: true, matchedRules: ["protected_zone:src/auth/**"] },
  contemplatedAction: { kind: "apply_patch", summary: "Reject empty parser input", affectedPaths: ["src/auth/session.ts"] }
};

function renderForm() {
  const action = vi.fn();
  render(
    <CheckpointForm
      checkpointId="4f8f8ec8-8fea-4ccf-9a12-79080e2dd0d8"
      packageHash={"b".repeat(64)}
      frozenPackage={frozenPackage}
      action={action}
    />
  );
  return action;
}

describe("CheckpointForm", () => {
  it("renders the frozen package and every independent classification control", () => {
    renderForm();
    expect(screen.getByText("Independent checkpoint classification")).toBeDefined();
    expect(screen.getByText("b".repeat(64))).toBeDefined();
    for (const label of ["Boundary", "Plan relationship", "Decision", "Facts", "Confidence", "Operator rationale"]) {
      expect(screen.getByText(new RegExp(`^${label}$`))).toBeDefined();
    }
    expect(screen.getByRole("button", { name: "Commit independent classification" })).toBeDefined();
  });

  it("carries the checkpoint id so the submission targets the exact frozen checkpoint", () => {
    renderForm();
    const hidden = document.querySelector<HTMLInputElement>('input[name="checkpointId"]');
    expect(hidden?.value).toBe("4f8f8ec8-8fea-4ccf-9a12-79080e2dd0d8");
  });

  it("shows the deterministic policy evaluation the operator must respect", () => {
    renderForm();
    expect(screen.getByText(/protected_zone:src\/auth/)).toBeDefined();
  });

  it("never references the agent's committed classification before submission", async () => {
    const forbidden = ["agentPayload", "agentClassification", "judgmentComparisons", "comparison", "reveal"];
    for (const file of ["checkpoint-form.tsx", "page.tsx"]) {
      // Comments are stripped so the guard tests what the page can actually fetch or render,
      // not prose that happens to name the thing being withheld.
      const source = (await readFile(join(pageDirectory, file), "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const token of forbidden) {
        expect(source.includes(token), `${file} must not reference ${token}`).toBe(false);
      }
    }
  });
});
