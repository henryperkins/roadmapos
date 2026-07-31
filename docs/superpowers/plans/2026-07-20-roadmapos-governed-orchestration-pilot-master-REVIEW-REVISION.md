# RoadmapOS Governed Orchestration Pilot Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the supervised, instrumented RoadmapOS concierge pilot defined in the approved Revision 2 validation specification, from GitHub roadmap readiness through a verified draft pull request and an auditable pilot report.

**Architecture:** Use a TypeScript monorepo with a Fastify control plane, PostgreSQL-backed workflow and audit state, a Next.js operator/auditor portal, a GitHub App adapter, an OpenAI Agents SDK adapter that returns Zod-validated decisions, and a restricted local workspace runner. The system is event-driven through a PostgreSQL job table; all consequential writes pass through the same frozen-checkpoint and independent operator gate before execution.

**Tech Stack:** TypeScript, Node.js, pnpm workspaces, Fastify, Next.js, PostgreSQL, Drizzle ORM, Zod, Octokit, OpenAI Agents SDK, Docker, Vitest, Playwright.

## Global Constraints

- Source specification: `docs/superpowers/specs/2026-07-20-governed-orchestration-validation-design-REVISION-2.md`.
- Recruit four to six public open-source repositories, target five complete matched pairs, and expect eight to twelve live executions; fewer than four analyzable pairs permits case-study reporting only.
- Each repository must have an active maintainer able to complete both conditions, a public approved-work source, repeatable validation, sufficient implementation context, two comparable bounded items, at least one normal repository-defined protected zone, and no need to expose private credentials, private user data, or restricted infrastructure.
- Each work item must have fixed desired outcomes and acceptance criteria, fit one pull request, be low or moderate risk, be reversible through Git history, be testable without production deployment, avoid merge/publish/release work, and have a comparable counterpart.
- Record expected governance exposure and the maintainer's coarse interactive-copilot effort band before assignment; governance exposure is a matching dimension rather than an exclusion criterion.
- Randomize item-to-condition assignment before showing AI analysis, record the draw, record execution order separately, and counterbalance which condition runs first across repositories.
- Use the same maintainer for both conditions when feasible and hold model family/configuration, repository context, tools, validation commands, endpoint standard, operator safety review, telemetry, and survey instruments materially equivalent.
- The live pilot covers bounded, reversible pull-request work only; it never merges, deploys, publishes, releases, changes identity or permissions, retrieves secrets for agent use, or performs destructive repository administration.
- Every consequential action in both conditions uses the same pre-write safety gate and governance-checkpoint schema.
- The agent classification is committed before the operator receives the checkpoint package; the operator must not see the agent label before submitting an independent label.
- The operator decision governs every live consequential action only within the frozen deterministic policy result; a platform hard stop always forces `stop`, and a repository-protected boundary cannot continue without escalation.
- The operator may block, pause, or route work but may not silently write product code, choose the implementation strategy, resolve requirements, or supply hidden repository context.
- Repository protections are the most restrictive combination of platform hard stops, native GitHub protections, and `.roadmapos/policy.yml`.
- Approval permission is checked live at action time; the default minimum role is `maintain`; execution-plan and escalation quorums default to one distinct eligible maintainer.
- A plan approval applies only to one immutable plan version and content hash.
- Across the study, at least two matched pairs are governance-bearing.
- Cross-repository delivery interpretation requires at least four analyzable matched pairs.
- Governance interpretation requires at least sixteen adjudicable events: at least six live and ten preregistered challenges, including at least two adjudicated `continue` and two adjudicated `pause-and-escalate` or `stop` live events.
- Challenge coverage includes four continue-permitted variations, four escalation-required events with two protected-zone interactions and one plan invalidation, two platform-hard-stop events, and one requirement-conflict or verification-failure event.
- Telemetry sessions stop after two consecutive inactive minutes.
- Effort discrepancies greater than five minutes or 25 percent, whichever is greater, require maintainer reconciliation.
- Failed and abandoned work stays in the all-assigned record; no artificial completion time is assigned.
- Effort aggregates are labeled survivor- and assistance-conditioned and include only pairs with two unassisted completed endpoints.
- The fixed quality observation window is fourteen calendar days after endpoint or termination.
- The strongest positive outcome is advancement to a supervised instrumented MVP; this pilot never authorizes removal of the human governance gate.
- No provider API key, GitHub installation token, webhook secret, encryption key, or signed-link secret may enter an agent prompt, repository checkout, test log, Git remote URL, or persisted artifact.

---

## Milestone decomposition

This specification spans three independently reviewable subsystems. Execute them in order.

### Milestone 1: Governance Core and Pilot Registry

Plan: `docs/superpowers/plans/2026-07-20-roadmapos-01-governance-core-REVIEW-REVISION.md`

Produces a runnable control-plane API with:

- typed domain contracts;
- immutable hashing and encrypted hidden records;
- PostgreSQL schema and append-only audit chain;
- repository policy parsing and action evaluation;
- matched-pair assignment; and
- internal operator/auditor authentication.

Exit check:

```bash
pnpm --filter @roadmapos/domain --filter @roadmapos/policy --filter @roadmapos/db test
pnpm --filter @roadmapos/control-plane test
pnpm typecheck
pnpm lint
```

Expected: all unit and PostgreSQL integration tests pass; a sample pilot, repository, pair, and immutable policy snapshot can be created through the API.

### Milestone 2: Supervised GitHub Execution

Plan: `docs/superpowers/plans/2026-07-20-roadmapos-02-supervised-github-workflows-REVIEW-REVISION.md`

Produces one complete supervised repository workflow with:

- GitHub App webhooks and commands;
- live permission and quorum checks;
- immutable plan generation and approval;
- interactive-copilot and governed-orchestration state machines;
- restricted patch and validation execution;
- blind agent/operator checkpoint classification;
- escalation and deviation disclosure; and
- draft pull-request creation.

Exit check:

```bash
pnpm --filter @roadmapos/github --filter @roadmapos/agent --filter @roadmapos/runner test
pnpm --filter @roadmapos/control-plane test
pnpm --filter @roadmapos/portal test
pnpm typecheck
pnpm lint
```

Expected: a fake GitHub repository completes both experimental conditions through the same safety gate, with the agent label hidden until the operator submits.

### Milestone 3: Evidence, Audit, and Reporting

Plan: `docs/superpowers/plans/2026-07-20-roadmapos-03-evidence-and-reporting-REVIEW-REVISION.md`

Produces the complete pilot harness with:

- preregistered challenge events;
- effort and monitoring measurement;
- verified review-ready endpoint checks;
- quality, trust, incident, intervention, and audit records;
- all-assigned and survivor-conditioned analyses;
- operator-subsidy sensitivity;
- portal dashboards, database-enforced results release, and fixed-interpretation exports; and
- an end-to-end rehearsal and readiness command.

Exit check:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm e2e
pnpm pilot:readiness 10000000-0000-4000-8000-000000000001
```

Expected: the deterministic full-pilot fixture produces the expected pair table, judgment confusion matrix, audit queue, guardrail status, and `advance_supervised_instrumented_mvp`, `iterate`, `governance_evidence_insufficient`, `inconclusive`, or `stop_and_redesign` decision without mutating a live repository.

## Cross-milestone interface map

Milestone 1 publishes the stable primitives consumed by every later milestone:

```ts
export function canonicalJson(value: unknown): string;
export function sha256Text(value: string): string;
export function sha256Canonical(value: unknown): string;

export class SecretBox {
  constructor(base64Key: string);
  seal(value: unknown, associatedData: string): SealedArtifact;
  open<T>(artifact: SealedArtifact, associatedData: string): T;
}

export function parseRepositoryPolicy(source: string): RepositoryPolicy;
export function buildEffectivePolicy(repository: RepositoryPolicy, github: GitHubProtectionSnapshot): EffectivePolicy;
export function evaluateAction(policy: EffectivePolicy, action: ActionProposal): ActionPolicyEvaluation;
export function appendAuditEvent(database: Database, input: AuditEventInput): Promise<AuditEventRecord>;
export function enqueueJob(database: Database, jobType: string, payload: unknown): Promise<string>;
```

Milestone 2 publishes the provider and execution boundaries consumed by Milestone 3. The detailed definitions in Tasks 8–12 are authoritative; the signatures below must remain synchronized with them:

```ts
export interface AgentResult<T> {
  value: T;
  requestHash: string;
  outputHash: string;
  providerTraceId: string | null;
}

export interface AgentGateway {
  generatePlan(input: PlanGenerationInput): Promise<AgentResult<ExecutionPlanDraft>>;
  proposeNextAction(input: ActionContext): Promise<AgentResult<ActionProposal>>;
  classifyCheckpoint(input: CheckpointPackage): Promise<AgentResult<JudgmentClassification>>;
}

export interface GitHubGateway {
  getRepositoryPermission(input: GitHubPermissionQuery): Promise<RepositoryPermission>;
  publishIssueComment(input: IssueCommentInput): Promise<PublishedRecord>;
  publishCheck(input: CheckInput): Promise<PublishedRecord>;
  openDraftPullRequest(input: DraftPullRequestInput): Promise<DraftPullRequestRecord>;
  getBranchHead(input: BranchHeadQuery): Promise<string>;
  getFile(input: RepositoryFileQuery): Promise<string>;
  getBranchProtection(input: BranchProtectionQuery): Promise<BranchProtectionRecord>;
}

export interface WorkspaceRunner {
  prepare(input: WorkspaceRequest): Promise<WorkspaceHandle>;
  readFiles(handle: WorkspaceHandle, paths: string[]): Promise<ReadonlyFile[]>;
  applyPatch(handle: WorkspaceHandle, patch: string): Promise<PatchResult>;
  runValidation(handle: WorkspaceHandle, commandId: string): Promise<ValidationResult>;
  commitAndPush(handle: WorkspaceHandle, message: string, installationToken: string): Promise<CommitResult>;
}

export class ExecutionRepository {
  transition(input: RunTransitionInput): Promise<RunState>;
  transitionTx(transaction: SqlTransaction, input: RunTransitionInput): Promise<RunState>;
}

export class CheckpointService {
  freeze(input: FreezeCheckpointInput): Promise<FrozenCheckpoint>;
  getOperatorView(checkpointId: string): Promise<BlindOperatorCheckpointView>;
  recordOperatorClassification(input: OperatorClassificationSubmission): Promise<RevealedJudgmentComparison>;
  resolveLiveGate(checkpointId: string): Promise<LiveGateDecision>;
  resolveExecutionAuthorization(checkpointId: string): Promise<ExecutionAuthorization>;
}
```


The map contains only symbols explicitly defined and exported by the milestone plans. Inline anonymous shapes are not promoted to named contracts here; when a named contract appears in this map, its task definition must export the same name and signature. `GitHubPermissionQuery` is intentionally distinct from all domain authorization records.

Workflow reducers import domain values and events only. Concrete PostgreSQL, GitHub, model-provider, and workspace classes are assembled at the control-plane boundary. Milestone 3 derives evidence only from durable records written through these services and the append-only audit chain.

## Specification coverage matrix

| Revision 2 specification area | Implemented by |
|---|---|
| §4 Product control model | Tasks 8, 11, 12, 13, and 14 |
| §5 Layered governance model | Tasks 5, 8, 11, 12, 13, and 14 |
| §6 Validation architecture and matched assignment | Tasks 6, 15, 18, 21, and 22 |
| §7 Experimental conditions and verified endpoint | Tasks 7, 11, 13, 14, and 17 |
| §8 Agent–operator agreement instrument | Tasks 12, 15, 18, 19, and 20 |
| §9 Active maintainer effort and failure-sensitive analysis | Tasks 16, 19, and 20 |
| §10 Safety, quality, trust, and workload guardrails | Tasks 17, 18, 19, and 20 |
| §11 Incident rubric and independent review | Tasks 18, 19, 20, and 22 |
| §12 Limited product-stage decision framework | Tasks 19, 20, and 21 |
| §13 Pilot integrity and operations | Tasks 10, 12–18, and 22 |
| §14 Pair-first reporting | Tasks 19 and 20 |
| §15 Non-goals | Master global constraints and Task 22 launch checks |
| §16 Assumptions to observe | Tasks 19, 21, and 22 |
| §17 Readiness checklist | Task 22 |

Each row is covered by at least one production service or enforcement task and at least one verification, rehearsal, audit, or reporting task. Challenge evidence, live evidence, operator effort, and maintainer effort remain separate throughout.

## Final integration order

1. Merge Milestone 1 after its migration, policy, hashing, and assignment tests pass.
2. Rebase Milestone 2 on the Milestone 1 interfaces; do not change published signatures without updating this master plan and all dependent tests.
3. Merge Milestone 2 only after the hidden-classification integration test proves that operator payloads exclude the agent label.
4. Rebase Milestone 3 and run the full deterministic fixture.
5. Run a dry pilot against a dedicated test organization with merge, release, deployment, and administrative permissions absent from the GitHub App installation.
6. Complete the readiness report before recruiting a public repository.
