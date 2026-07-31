import { expect, it } from "vitest";
import { runRevisionFixture } from "./support/plan-revision-fixture.js";

it("invalidates approvals for a material revision and carries them only after an operator editorial decision", async () => {
  const material = await runRevisionFixture({ operatorRelationship: "material_scope_expansion" });
  expect(material.activeApprovalCountForNewPlan).toBe(0);
  expect(material.runState).toBe("awaiting_plan_approval");

  const editorial = await runRevisionFixture({ operatorRelationship: "editorial_only" });
  expect(editorial.carriedApprovalCount).toBe(1);
  expect(editorial.activeApprovalCountForNewPlan).toBe(1);
  expect(editorial.runState).toBe("proposing_action");
});
