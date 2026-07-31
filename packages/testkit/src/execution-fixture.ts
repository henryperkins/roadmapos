import { createHash } from "node:crypto";
import {
  actionProposals,
  matchedPairs,
  pilotStudies,
  repositories,
  repositoryPolicyVersions,
  runs,
  workItems,
  type Database
} from "@roadmapos/db";
import {
  sha256Canonical,
  type CheckpointPackage,
  type Condition,
  type ExecutionPlanDraft,
  type JudgmentClassification,
  type RunState
} from "@roadmapos/domain";
import { parseRepositoryPolicy, type RepositoryPolicy } from "@roadmapos/policy";

export const FIXTURE_BASE_SHA = "a".repeat(40);
export const FIXTURE_PUBLIC_BASE_URL = "http://localhost:3000";
export const FIXTURE_PROTECTED_PATH = "src/auth/**";

export interface ExecutionFixtureOptions {
  condition?: Condition;
  runState?: RunState;
  executionPlanQuorum?: number;
  escalationQuorum?: number;
  minimumApprovalRole?: "write" | "maintain" | "admin";
  issueNumberOffset?: number;
  protectedZonePath?: string;
  baseSha?: string;
}

export interface ControlPlaneTestConfig {
  databaseUrl: string;
  operatorTokenSha256: string;
  auditorTokenSha256: string;
  artifactEncryptionKeyBase64: string;
  pilotLinkSecret: string;
  publicBaseUrl: string;
  githubAppId: string;
  githubPrivateKeyBase64: string;
  githubWebhookSecret: string;
  githubReadyLabel: string;
}

export interface ExecutionFixture {
  pilotId: string;
  repositoryId: string;
  policyVersionId: string;
  policy: RepositoryPolicy;
  policyHash: string;
  workItemId: string;
  issueNumber: number;
  runId: string;
  condition: Condition;
  baseSha: string;
  branchName: string;
  planId: string;
  proposalId: string;
  publicBaseUrl: string;
  planDraft: ExecutionPlanDraft;
  classifier: (input: CheckpointPackage) => JudgmentClassification;
  checkpointInput: {
    runId: string;
    source: "agent_detected";
    actionProposalId: string;
    package: CheckpointPackage;
  };
  controlPlaneConfig: <T extends Partial<ControlPlaneTestConfig> & Record<string, unknown>>(
    overrides: T
  ) => ControlPlaneTestConfig & T;
}

/** The plaintext bearer token whose SHA-256 the fixture control-plane config expects for operators. */
export const FIXTURE_OPERATOR_TOKEN = "hi";
/** The plaintext bearer token whose SHA-256 the fixture control-plane config expects for auditors. */
export const FIXTURE_AUDITOR_TOKEN = "bye-auditor";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fixturePolicySource(input: {
  executionPlanQuorum: number;
  escalationQuorum: number;
  minimumApprovalRole: "write" | "maintain" | "admin";
  protectedZonePath: string;
}): string {
  return [
    "version: 1",
    "authorization:",
    `  minimum_approval_role: ${input.minimumApprovalRole}`,
    `  execution_plan_quorum: ${String(input.executionPlanQuorum)}`,
    `  escalation_quorum: ${String(input.escalationQuorum)}`,
    "protected_zones:",
    `  - path: "${input.protectedZonePath}"`,
    '    reason: "Authentication and session handling"',
    "dependencies:",
    "  additions_require_escalation: true",
    "public_interfaces:",
    "  changes_require_escalation: true",
    "execution:",
    "  readable_paths:",
    '    - "src/**"',
    '    - "README.md"',
    "  validation_commands:",
    "    - id: unit",
    '      argv: ["npm", "test"]',
    "      timeout_seconds: 600"
  ].join("\n");
}

export const FIXTURE_PLAN_DRAFT: ExecutionPlanDraft = {
  problemInterpretation: "The parser accepts empty input and should reject it",
  acceptanceCriteria: ["Empty input is rejected with a descriptive error"],
  expectedPublicBehavior: ["parse('') throws InvalidInput"],
  implementationSteps: ["Guard the parser entry point", "Extend the unit tests"],
  anticipatedPaths: ["src/a.ts", "src/parser.ts"],
  dependencies: [],
  protectedZoneExpectations: [],
  verificationCommandIds: ["unit"],
  risks: ["A stricter guard could reject previously tolerated input"],
  rollback: "Revert the single commit on the RoadmapOS branch"
};

/**
 * Deterministic stand-in for the model classifier. It derives its answer from the frozen
 * deterministic policy evaluation, so a fixture checkpoint never produces a classification the
 * server would reject (a hard stop always resolves to `stop`, a protected zone never to `continue`).
 */
export function fixtureClassifier(input: CheckpointPackage): JudgmentClassification {
  const boundary = input.policyEvaluation?.boundary ?? "none";
  if (boundary === "platform_hard_stop") {
    return {
      boundary,
      planRelationship: "within_plan",
      decision: "stop",
      affectedPolicyRules: input.policyEvaluation?.matchedRules ?? [],
      facts: ["The contemplated action is a platform hard stop"],
      requiredDisclosureFields: [],
      reversible: false,
      confidence: 100
    };
  }
  if (boundary === "repository_protected") {
    return {
      boundary,
      planRelationship: "material_scope_expansion",
      decision: "pause_and_escalate",
      affectedPolicyRules: input.policyEvaluation?.matchedRules ?? [],
      facts: ["The contemplated action touches a repository-protected boundary"],
      requiredDisclosureFields: ["affected protected zone"],
      reversible: true,
      confidence: 90
    };
  }
  return {
    boundary: "none",
    planRelationship: "within_plan",
    decision: "continue",
    affectedPolicyRules: [],
    facts: ["The contemplated action stays within the approved authorization"],
    requiredDisclosureFields: [],
    reversible: true,
    confidence: 95
  };
}

export const FIXTURE_PATCH =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

export async function seedExecutionFixture(
  database: Database,
  options: ExecutionFixtureOptions = {}
): Promise<ExecutionFixture> {
  const condition: Condition = options.condition ?? "governed_orchestration";
  const runState: RunState = options.runState ?? "proposing_action";
  const baseSha = options.baseSha ?? FIXTURE_BASE_SHA;
  const issueNumber = 1 + (options.issueNumberOffset ?? 0);
  const policy = parseRepositoryPolicy(
    fixturePolicySource({
      executionPlanQuorum: options.executionPlanQuorum ?? 1,
      escalationQuorum: options.escalationQuorum ?? 1,
      minimumApprovalRole: options.minimumApprovalRole ?? "maintain",
      protectedZonePath: options.protectedZonePath ?? FIXTURE_PROTECTED_PATH
    })
  );
  const policyHash = sha256Canonical(policy);

  const pilotId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const policyVersionId = crypto.randomUUID();
  const workItemId = crypto.randomUUID();
  const partnerItemId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const proposalId = crypto.randomUUID();
  const branchName = `roadmapos/${runId}`;

  await database.db.insert(pilotStudies).values({ id: pilotId, name: "Execution fixture", status: "running" });
  await database.db.insert(repositories).values({
    id: repositoryId,
    pilotId,
    githubRepositoryId: BigInt(1000 + issueNumber),
    installationId: BigInt(2000 + issueNumber),
    owner: "acme",
    name: "widget",
    defaultBranch: "main"
  });
  await database.db.insert(repositoryPolicyVersions).values({
    id: policyVersionId,
    repositoryId,
    sourceCommitSha: baseSha,
    policyJson: policy,
    policyHash,
    createdBy: "fixture"
  });
  await database.db.insert(workItems).values([
    {
      id: workItemId,
      repositoryId,
      githubIssueNumber: issueNumber,
      githubIssueNodeId: `I_${String(issueNumber)}`,
      title: "Reject empty parser input",
      acceptanceCriteria: ["Empty input is rejected with a descriptive error"],
      expectedEffortBand: "30_to_60",
      expectedGovernanceExposure: "one protected zone interaction",
      condition,
      executionOrder: 1
    },
    {
      id: partnerItemId,
      repositoryId,
      githubIssueNumber: issueNumber + 1,
      githubIssueNodeId: `I_${String(issueNumber + 1)}`,
      title: "Reject empty serializer input",
      acceptanceCriteria: ["Empty input is rejected with a descriptive error"],
      expectedEffortBand: "30_to_60",
      expectedGovernanceExposure: "one protected zone interaction",
      condition: condition === "governed_orchestration" ? "interactive_copilot" : "governed_orchestration",
      executionOrder: 2
    }
  ]);
  await database.db.insert(matchedPairs).values({
    id: crypto.randomUUID(),
    pilotId,
    repositoryId,
    workItemAId: workItemId,
    workItemBId: partnerItemId,
    governanceBearing: true,
    matchingRecord: { expectedComplexity: "low" }
  });

  await database.db.insert(runs).values({
    id: runId,
    pilotId,
    workItemId,
    repositoryId,
    policyVersionId,
    condition,
    state: runState,
    baseSha,
    branchName
  });

  const action = {
    kind: "apply_patch" as const,
    patch: FIXTURE_PATCH,
    summary: "Reject empty parser input",
    affectedPaths: ["src/a.ts"],
    discoveredFacts: ["The parser has no empty-input guard"],
    changesPublicInterface: false,
    changesDependencies: false,
    changesSecurityBehavior: false
  };
  await database.db.insert(actionProposals).values({
    id: proposalId,
    runId,
    sequence: 1,
    actionJson: action,
    actionHash: sha256Canonical(action),
    status: "proposed"
  });

  const checkpointPackage: CheckpointPackage = {
    schemaVersion: 1,
    repository: { owner: "acme", name: "widget", baseSha },
    policyHash,
    authorization: { kind: "execution_plan", version: 1, contentHash: sha256Canonical(FIXTURE_PLAN_DRAFT) },
    policyEvaluation: { boundary: "none", requiresEscalation: false, matchedRules: [] },
    contemplatedAction: {
      kind: "apply_patch",
      summary: action.summary,
      affectedPaths: action.affectedPaths
    },
    discoveredFacts: action.discoveredFacts,
    validationState: { completedCommandIds: [], failingCommandIds: [] },
    reversible: true,
    createdAt: new Date().toISOString()
  };

  return {
    pilotId,
    repositoryId,
    policyVersionId,
    policy,
    policyHash,
    workItemId,
    issueNumber,
    runId,
    condition,
    baseSha,
    branchName,
    planId: crypto.randomUUID(),
    proposalId,
    publicBaseUrl: FIXTURE_PUBLIC_BASE_URL,
    planDraft: FIXTURE_PLAN_DRAFT,
    classifier: fixtureClassifier,
    checkpointInput: { runId, source: "agent_detected", actionProposalId: proposalId, package: checkpointPackage },
    controlPlaneConfig: (overrides) => ({
      databaseUrl: "",
      operatorTokenSha256: sha256Hex(FIXTURE_OPERATOR_TOKEN),
      auditorTokenSha256: sha256Hex(FIXTURE_AUDITOR_TOKEN),
      artifactEncryptionKeyBase64: Buffer.alloc(32, 1).toString("base64"),
      pilotLinkSecret: "pilot-link-secret-123",
      publicBaseUrl: FIXTURE_PUBLIC_BASE_URL,
      githubAppId: "1",
      githubPrivateKeyBase64: Buffer.from("private-key").toString("base64"),
      githubWebhookSecret: "webhook-secret-123",
      githubReadyLabel: "roadmapos:ready",
      ...overrides
    })
  };
}
