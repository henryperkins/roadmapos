# RoadmapOS Milestone 1 (Governance Core) — Implementation Notes

**Status:** Complete and verified. All six tasks implemented, six commits, full suite green.

**Verified on 2026-07-20:**

- Clean migration succeeds and is idempotent on re-run (9 tables).
- `pnpm test` — 9 test files, 20 tests, all passing (deterministic across repeated runs).
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.

## How to run

PostgreSQL is required. The plan's `docker-compose.yml` (Postgres 17) is committed and is the intended path, but this environment had no Docker daemon, so a local PostgreSQL 16 cluster was used instead — functionally equivalent for this milestone (only standard SQL + `pgcrypto`).

```bash
# 1. Start Postgres and create the role + databases (once)
#    role: roadmapos / roadmapos, databases: roadmapos and roadmapos_test
# 2. Copy .env.example to .env and fill in the secrets:
#    - ARTIFACT_ENCRYPTION_KEY_BASE64: openssl rand -base64 32
#    - PILOT_LINK_SECRET:              openssl rand -hex 24  (>= 16 chars)
#    - OPERATOR_TOKEN_SHA256 / AUDITOR_TOKEN_SHA256: sha256 hex of your chosen bearer tokens
# 3. Load env and run:
set -a; . ./.env; set +a
pnpm install
pnpm db:migrate
pnpm test        # domain, policy, db, control-plane
pnpm typecheck
pnpm lint
```

Tests read `TEST_DATABASE_URL`; the migrate script and server read `DATABASE_URL`.

## Toolchain pinning (important)

The plan's `pnpm add` commands are unpinned. On a fresh install today the registry resolves bleeding-edge majors — Zod 4, Vitest 4, TypeScript 7, ESLint 10 — but the plan's code and config are written against the previous stable lines (Zod 3 error/issue APIs, Vitest's `defineWorkspace`/`--workspace`, TS 5-era config, ESLint 9 that typescript-eslint@8 supports). Chasing the majors would have meant rewriting the plan's provided Zod schemas (changing error-message formats the tests assert on) and the workspace test config.

To keep the implementation faithful to the plan's source, the toolchain is pinned to:

- typescript 5.9, zod 3.25, vitest + @vitest/coverage-v8 3.2, eslint + @eslint/js 9, typescript-eslint 8.
- Runtime libs kept at current majors (drizzle-orm 0.45, postgres 3.4, fastify 5, @fastify/sensible 6) — all compatible with the plan's usage.

If the project later intends to adopt Zod 4 / Vitest 4 / TS 7, that should be a deliberate, separately-scoped migration.

## Deviations from the plan

Each item below is a place where the plan's literal text was incomplete or internally inconsistent and had to be corrected to build and pass. None change the intended architecture or behavior.

1. **`@types/node` added** (root devDependency). The plan lists no `@types/node`, but the code uses Node built-ins throughout (`node:crypto`, `Buffer`, `crypto.randomUUID`, `process`). Required for typecheck.

2. **testkit migrations path off-by-one.** `packages/testkit/src/database.ts` resolved migrations via `../../../db/src/migrations`, which from `packages/testkit/src/` lands at `<root>/db/src/migrations` (no `packages/`). Corrected to `../../db/src/migrations`.

3. **`SqlTransaction` type extraction.** The plan's `Parameters<Parameters<Database["sql"]["begin"]>[0]>[0]` breaks because postgres's `begin` is overloaded — TypeScript selects the `(options: string, cb)` overload, so `[0]` is `string`. Replaced with the exported `postgres` transaction type (`Postgres.TransactionSql`).

4. **`sql.json()` vs Drizzle (functional bug, not just types).** `drizzle(sql)` from `drizzle-orm/postgres-js` mutates the shared postgres client's serializers, which breaks `sql.json()` / `transaction.json()` on that same client (raises "Received an instance of Object" at bind time). The two raw JSON inserts (`audit-events.ts`, `jobs.ts`) were changed to the standard `${JSON.stringify(value)}::jsonb` idiom, which does not depend on the mutated serializer. Drizzle's own `.insert({ jsonbCol })` path is unaffected and still used elsewhere.

5. **Missing package dependencies.** Added: `@roadmapos/testkit` (dev) to `@roadmapos/db` and to `@roadmapos/control-plane` (their tests import it); `postgres` to `@roadmapos/testkit` (its reset helper imports it); `drizzle-orm` to `@roadmapos/control-plane` (`pilot-registry.ts` imports `eq`).

6. **Route test used an invalid secret.** `pilot-routes.test.ts` passed `pilotLinkSecret: "link-secret"` (11 chars), but `ControlPlaneConfigSchema` requires `min(16)`. The schema minimum is the intended production invariant, so the test placeholder was lengthened (to `"link-secret-value"`) rather than weakening the schema. Also removed an unused `createDatabase` import from that test.

7. **ESLint config adjustments** (`eslint.config.mjs`). (a) Root config files `eslint.config.mjs` and `vitest.workspace.ts` are excluded from linting — typescript-eslint's project service can't associate them with any package tsconfig. (b) `@typescript-eslint/require-await` turned off — the Fastify plugin/handler/hook functions are async for interface conformance even when a given body has nothing to await. (c) `@typescript-eslint/no-unused-vars` configured with `ignoreRestSiblings` and `^_` patterns to allow the intentional "omit a key via rest destructure" in `assignPair`.

8. **Small domain lint fixes** to satisfy the plan's own `strictTypeChecked` config: `canonical-json.ts` uses `typeof value` instead of `String(value)` in the unsupported-value error (also avoids the symbol-in-template throw); `schemas.ts` imports `RepositoryPermissionSchema` as a `type`; `SecretBox.open<T>` carries an inline disable for `no-unnecessary-type-parameters` because the generic is the published interface-map contract; `worker.ts` wraps `process.pid` in `String()`.

9. **`vitest.config.ts` — `fileParallelism: false`** added uniformly to all five configs. The db and control-plane integration tests share a single `roadmapos_test` database and reset it per-test, so file-level parallelism must be disabled or the test files race (drop-schema during another file's test). Applied uniformly so the five configs remain identical to one another, per the plan's "configs must match" intent. This makes both `pnpm test` and per-package runs deterministic.

## What Milestone 1 delivers (for Milestone 2)

The stable primitives the master plan's interface map promises are exported and tested: `canonicalJson` / `sha256Text` / `sha256Canonical`, `SecretBox`, `signPilotLink` / `verifyPilotLink`, `parseRepositoryPolicy` / `buildEffectivePolicy` / `evaluateAction`, `appendAuditEvent` / `enqueueJob`, the Drizzle schema + append-only audit chain, the counterbalanced `PilotRegistry.assignPair`, and the internal-role Fastify control plane. Milestone 2 can rebase on these signatures.
