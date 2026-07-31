import { describe, expect, it } from "vitest";
import { reduceRunState } from "../src/index.js";

describe("reduceRunState", () => {
  it("moves a governed run from registration to plan approval and execution", () => {
    expect(reduceRunState("registered", { type: "analysis_started" }, "governed_orchestration")).toBe("planning");
    expect(reduceRunState("planning", { type: "plan_published" }, "governed_orchestration")).toBe("awaiting_plan_approval");
    expect(reduceRunState("awaiting_plan_approval", { type: "plan_quorum_reached" }, "governed_orchestration")).toBe("proposing_action");
  });

  it("moves an interactive run to the instruction loop after every authorized action", () => {
    expect(reduceRunState("registered", { type: "analysis_started" }, "interactive_copilot")).toBe("awaiting_instruction");
    expect(reduceRunState("executing_action", { type: "action_completed" }, "interactive_copilot")).toBe("awaiting_instruction");
    expect(reduceRunState("awaiting_escalation_approval", { type: "escalation_rejected" }, "interactive_copilot")).toBe("awaiting_instruction");
  });

  it("routes revision decisions and lost quorum without direct state writes", () => {
    expect(reduceRunState("proposing_action", { type: "nonconsequential_action_authorized" }, "governed_orchestration")).toBe("executing_action");
    expect(reduceRunState("proposing_action", { type: "plan_revision_frozen" }, "governed_orchestration")).toBe("awaiting_operator_gate");
    expect(reduceRunState("awaiting_operator_gate", { type: "editorial_revision_accepted" }, "governed_orchestration")).toBe("proposing_action");
    expect(reduceRunState("awaiting_operator_gate", { type: "material_revision_requires_approval" }, "governed_orchestration")).toBe("awaiting_plan_approval");
    expect(reduceRunState("proposing_action", { type: "plan_quorum_lost" }, "governed_orchestration")).toBe("awaiting_plan_approval");
    expect(reduceRunState("executing_action", { type: "plan_quorum_lost" }, "governed_orchestration")).toBe("awaiting_plan_approval");
    expect(reduceRunState("executing_action", { type: "escalation_quorum_lost" }, "governed_orchestration")).toBe("awaiting_escalation_approval");
    expect(reduceRunState("awaiting_plan_approval", { type: "plan_quorum_restored_pending_escalation" }, "governed_orchestration")).toBe("awaiting_escalation_approval");
    expect(reduceRunState("awaiting_plan_approval", { type: "plan_quorum_restored_authorized_action" }, "governed_orchestration")).toBe("executing_action");
  });

  it("rejects a gate approval from the wrong state", () => {
    expect(() => reduceRunState("planning", { type: "operator_continue" }, "governed_orchestration")).toThrow("Invalid run transition");
  });
});
