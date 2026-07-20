import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@roadmapos/db";
import { resetTestDatabase } from "@roadmapos/testkit";
import { PilotRegistry } from "../src/pilot-registry.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = createDatabase(url);
const registry = new PilotRegistry(database);

beforeEach(async () => resetTestDatabase(url));

describe("PilotRegistry", () => {
  it("freezes random item assignment while counterbalancing execution order", async () => {
    const fixture = await registry.createFixturePair();
    const first = await registry.assignPair(fixture.pairId, () => 0, () => 0);
    expect(first.itemACondition).toBe("governed_orchestration");
    expect(first.firstCondition).toBe("governed_orchestration");

    const secondPairId = await registry.createMatchedPair({
      pilotId: fixture.pilotId,
      repositoryId: fixture.repositoryId,
      governanceBearing: false,
      matchingRecord: { expectedComplexity: "low", expectedEffortBand: "30_to_60" },
      itemA: { issueNumber: 3, nodeId: "I_3", title: "C", acceptanceCriteria: ["C passes"], effortBand: "30_to_60", governanceExposure: "ordinary" },
      itemB: { issueNumber: 4, nodeId: "I_4", title: "D", acceptanceCriteria: ["D passes"], effortBand: "30_to_60", governanceExposure: "ordinary" }
    });
    const second = await registry.assignPair(secondPairId, () => 0, () => 0);
    expect(second.itemACondition).toBe("governed_orchestration");
    expect(second.firstCondition).toBe("interactive_copilot");
    expect(second.assignmentHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(registry.assignPair(secondPairId, () => 1, () => 1)).rejects.toThrow("Pair is already assigned");
  });
});
