import { describe, expect, it } from "vitest";
import { parseRoadmapOsCommand } from "../src/index.js";

describe("parseRoadmapOsCommand", () => {
  it("parses immutable plan approval", () => {
    expect(parseRoadmapOsCommand("/roadmapos approve-plan 2 abcdef1234567890")).toEqual({
      kind: "approve_plan",
      version: 2,
      hashPrefix: "abcdef1234567890"
    });
  });

  it("parses an interactive one-action authorization", () => {
    expect(parseRoadmapOsCommand("/roadmapos do 4f8f8ec8-8fea-4ccf-9a12-79080e2dd0d8")).toEqual({
      kind: "authorize_action",
      proposalId: "4f8f8ec8-8fea-4ccf-9a12-79080e2dd0d8"
    });
  });

  it("parses the remaining supervised verbs", () => {
    expect(parseRoadmapOsCommand("/roadmapos next")).toEqual({ kind: "next_action" });
    expect(parseRoadmapOsCommand("/roadmapos review-ready")).toEqual({ kind: "review_ready" });
    expect(parseRoadmapOsCommand("/roadmapos revise-plan narrow the scope")).toEqual({ kind: "revise_plan", feedback: "narrow the scope" });
    expect(parseRoadmapOsCommand("/roadmapos approve-escalation 1 abcdef1234567890")).toEqual({
      kind: "approve_escalation",
      version: 1,
      hashPrefix: "abcdef1234567890"
    });
    expect(parseRoadmapOsCommand("/roadmapos reject-escalation 1")).toEqual({ kind: "reject_escalation", version: 1 });
    expect(parseRoadmapOsCommand("/roadmapos terminate out of scope")).toEqual({ kind: "terminate", reason: "out of scope" });
  });

  it("ignores noncommands and rejects ambiguous commands", () => {
    expect(parseRoadmapOsCommand("looks good")).toBeNull();
    expect(() => parseRoadmapOsCommand("/roadmapos approve-plan 2")).toThrow("Invalid RoadmapOS command");
  });
});
