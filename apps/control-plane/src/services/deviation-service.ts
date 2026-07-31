import { eq } from "drizzle-orm";
import { actionProposals, deviations, executionPlans, governanceCheckpoints, judgmentComparisons, runs, type Database } from "@roadmapos/db";
import { DeviationDisclosureSchema, sha256Canonical, type ActionProposal, type ExecutionPlanDraft, type JudgmentClassification } from "@roadmapos/domain";

/**
 * Records the public disclosure owed when an operator allows a variation to continue without an
 * escalation. Nothing here decides whether the action may run; it captures what must be disclosed.
 */
export class DeviationService {
  constructor(private readonly database: Database) {}

  async recordIfRequired(checkpointId: string) {
    const [record] = await this.database.db.select({ checkpoint: governanceCheckpoints, comparison: judgmentComparisons, proposal: actionProposals, run: runs, plan: executionPlans })
      .from(governanceCheckpoints)
      .innerJoin(judgmentComparisons, eq(judgmentComparisons.checkpointId, governanceCheckpoints.id))
      .innerJoin(actionProposals, eq(actionProposals.id, governanceCheckpoints.actionProposalId))
      .innerJoin(runs, eq(runs.id, governanceCheckpoints.runId))
      .leftJoin(executionPlans, eq(executionPlans.id, runs.currentPlanId))
      .where(eq(governanceCheckpoints.id, checkpointId));
    if (!record) throw new Error("Checkpoint not found");
    const operator = record.comparison.operatorPayload as JudgmentClassification;
    if (operator.decision !== "continue" || !["editorial_only", "materially_equivalent_variation"].includes(operator.planRelationship)) return null;
    const action = record.proposal.actionJson as ActionProposal;
    const anticipated = (record.plan?.planJson as ExecutionPlanDraft | null)?.anticipatedPaths ?? [];
    const affected = action.kind === "apply_patch" ? action.affectedPaths : [];
    const additionalFiles = affected.filter((path) => !anticipated.includes(path));
    const payload = DeviationDisclosureSchema.parse({
      originalPlanExpectation: anticipated.length > 0 ? anticipated.join(", ") : "No path expectation was recorded",
      actualImplementationVariation: actionSummaryForDeviation(action),
      continueWithoutEscalationReason: operator.facts.join(" "),
      additionalFiles,
      additionalDependencies: action.kind === "apply_patch" && action.changesDependencies ? ["Agent-declared dependency change"] : [],
      reversible: operator.reversible,
      evidence: operator.facts,
      confidence: operator.confidence
    });
    const id = crypto.randomUUID();
    const contentHash = sha256Canonical(payload);
    await this.database.db.insert(deviations).values({ id, runId: record.run.id, checkpointId, disclosureJson: payload, contentHash });
    return { id, contentHash, payload };
  }
}

function actionSummaryForDeviation(action: ActionProposal): string {
  if (action.kind === "apply_patch") return `${action.summary}; affected ${action.affectedPaths.join(", ")}`;
  if (action.kind === "run_validation") return `Validation ${action.commandId}`;
  if (action.kind === "commit_and_push") return action.summary;
  if (action.kind === "open_draft_pr") return action.title;
  if (action.kind === "read_files") return action.purpose;
  return action.summary;
}
