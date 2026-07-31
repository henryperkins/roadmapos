# RoadmapOS Milestone 2 (Supervised GitHub Workflows) — Implementation Notes

**Status:** Tasks 7–14 implemented, plus corrections for all ten Milestone 2 findings from the
external plan review. Full suite green and deterministic across repeated runs.

**Verified on 2026-07-31:**

- Clean migration succeeds and is idempotent on re-run (29 tables, migrations 0001–0006).
- `pnpm test` — 31 test files, 134 tests, identical across three consecutive runs.
- `pnpm typecheck` — clean. `pnpm lint` — clean.
- `rg "\.merge\(|createDeployment|createRelease|packages\."` finds no production code path that
  merges, deploys, releases, or publishes.

## How to run

Same prerequisites as Milestone 1 (PostgreSQL; this environment has no Docker daemon, so a local
PostgreSQL 16 cluster is used). `.env.example` lists every variable. Beyond Milestone 1 you now need
`ADMIN_TOKEN_SHA256`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_BASE64`, `GITHUB_WEBHOOK_SECRET`,
`GITHUB_READY_LABEL`, `WORKSPACE_ROOT`, `RUNNER_DOCKER_IMAGE`, `OPENAI_API_KEY`, `OPENAI_MODEL`, and
for the portal `CONTROL_PLANE_INTERNAL_URL` and `CONTROL_PLANE_OPERATOR_TOKEN`.

The deterministic suite makes no GitHub, model-provider, or Docker network call.

## Review findings and how each was closed

The review of the Milestone 2 plan raised ten findings. All are addressed in code.

1. **JSONB serializer defect (M2-1).** Never reintroduced — Milestone 1's `${JSON.stringify(v)}::jsonb`
   idiom is used everywhere, including the checkpoint reveal path. `packages/db/test/jsonb-serializer.test.ts`
   now initializes Drizzle *first*, then drives every raw JSONB write, and a static scan fails the
   build if the postgres client's `json()` helper reappears in any workspace source file.

2. **Branch protection 404 (M2-2).** `BranchProtectionRecord` carries a `determinacy`. A 404 counts
   as authoritatively unprotected only when the installation actually holds `Administration: read`
   (read from the installation's granted permissions); otherwise it is `indeterminate` with a
   reason. `ActionCoordinator` refuses to freeze a checkpoint over an indeterminate protection.
   **Deployment requirement:** grant the App `Administration: read`. It still holds no
   administration *write*, no merge, deployment, environment, or package-write permission.

3. **Agents SDK / Zod (M2-3).** `@openai/agents` is pinned to the 0.2 line, the last whose zod peer
   is `^3.25.40 || ^4.0`, so the workspace stays on Zod 3 as Milestone 1 deliberately chose. The
   SDK's structured `outputType` must be a Zod *object*, so the action union travels in a
   single-key envelope and the classifier generates against a new `JudgmentClassificationObjectSchema`;
   the discriminated union and the refined classification schema remain the authoritative parsers
   for every recorded value.

4. **Webhook ingestion (M2-4).** The raw-body parser is scoped inside an encapsulated plugin, so the
   internal JSON API keeps its normal parser (regression test included). The delivery row and its
   job now commit in one transaction, so a crash between them cannot mark a delivery processed with
   no work to do. A repeated delivery id with a different payload hash returns 409 rather than being
   silently dismissed as a duplicate.

5. **Model-declared metadata (M2-5).** The order is now parse → derive → compare → evaluate →
   freeze → execute the frozen hash. The patch parser lives in `@roadmapos/domain` so the policy
   evaluator and the workspace runner share one implementation. A description whose file set
   disagrees with the diff is rejected before any checkpoint exists. The two boolean effect claims
   are a lower bound only: a declared `false` is overridden when the diff shows a dependency
   manifest or a security-sensitive path, which can only make a decision stricter, and the
   understatement is recorded in `discoveredFacts` beside the claim. Execution re-derives the hash
   and refuses anything that is not the patch the operator cleared.

6. **Validation and privileged Git state (M2-6).** Validation runs on a disposable source-only
   snapshot exported with `git checkout-index`, asserted to contain no `.git`, and destroyed
   afterwards. Before any token-bearing operation the host re-establishes real path, origin, branch
   and descent from the recorded base SHA, and constructs the push target and refspec itself rather
   than reading them back from `origin`. A workspace this process never prepared is refused. The
   runner image warns unless digest-pinned.

7. **Containment and process limits (M2-7).** Every path component is resolved with `realpath`
   before a read; the workspace identifier must be an opaque UUID and containment is asserted before
   the recursive delete; process output is bounded with an explicit truncation marker; children run
   in their own process group so a timeout kills the tree and reports exit 124.

8. **Execution recoverability (M2-8).** Migration 0006 adds leased `execution_attempts` and an
   `execution_outbox`. An expired lease does not become claimable — the attempt moves to
   `reconciling` first, and reconciliation asks the remote what actually happened. A push that
   landed is confirmed and projected without pushing again; one that never left is abandoned and
   safely retried; anything ambiguous fails the attempt and routes the run to the operator gate
   through the new `execution_recovery_required` event. `action_failed` gives failure its own
   per-condition transition.

9. **Checkpoint and PR split-brain (M2-9).** Draft PR creation records its intent durably before
   calling GitHub and confirms afterwards, so a crash across that call is reconcilable instead of
   producing a duplicate PR on retry.

10. **Identity binding (M2-10).** Migration 0005 adds revoke-only `internal_access_tokens` binding a
    bearer token to exactly one participant. Auth resolves token → participant → pilot, and the
    reveal is attributed to that participant instead of the literal string `"operator"`. A separate
    bootstrap-only `admin` role creates pilots and can never classify a checkpoint. Cross-pilot
    integrity is enforced: an operator bound to another pilot is refused on both read and classify.
    `ExecutionRepository` no longer accepts `pilotId` or `condition` from callers; both come from the
    locked run row.

## Deviations from the plan text

Beyond the review corrections, these are places the plan's literal text could not be used as-is.

1. **Root `pnpm test` runs `--no-file-parallelism`.** Vitest runs workspace *projects* concurrently,
   so the db and control-plane suites raced on the single `roadmapos_test` database. The plan's
   per-package `fileParallelism: false` only serializes within a project.

2. **`seedExecutionFixture` defaults to `runState: "proposing_action"`,** which is what the blinding
   tests need; `plan-approval.test.ts` passes `runState: "planning"` explicitly.

3. **Migration 0004 and `revalidateBeforeExecution` were pulled forward** from Task 14 into Task 13,
   because Task 13's `executeAfterGate` fails closed without the pre-execution authorization guard.

4. **Task 14's orchestration fixtures live in `apps/control-plane/test/support/`,** not in the
   testkit: they drive `EscalationService`, `ApprovalService` and `ActionCoordinator`, and the
   control plane already depends on the testkit, so putting them there would be a dependency cycle.
   The pure seed helpers stay in the testkit.

5. **`runStructured` takes an object schema plus an authoritative parser** rather than a bare
   `ZodType`, because the SDK's `outputType` accepts only a Zod object (see finding 3).

6. **`apps/portal/lib/control-plane.ts` resolves credentials on first use** rather than at module
   load, so a build step that never calls the control plane does not need operator credentials. A
   request that does still fails loudly rather than falling back.

7. **`OPERATOR_TOKEN_SHA256` / `AUDITOR_TOKEN_SHA256` are gone** from the control-plane config,
   replaced by participant-bound tokens plus `ADMIN_TOKEN_SHA256` (see finding 10).

## Not addressed here

The review's Milestone 3 findings are untouched — Milestone 3 is not implemented. The review's
sequencing holds: Milestone 3 depends on Milestone 2 producing authoritative, recoverable execution
artifacts, which is what the work above establishes.

Two items from the review are deployment-time rather than code-time:

- The GitHub App installation must be granted `Administration: read` (finding 2).
- `RUNNER_DOCKER_IMAGE` must be digest-pinned, and the offline dependency-provisioning strategy for
  real repository validation commands still needs to be chosen. The runner warns on a mutable tag
  but cannot enforce provisioning.
