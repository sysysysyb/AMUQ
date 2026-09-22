# Workflow Status

> Updated: 2026-09-23 01:39 KST

## Current state

- Status: review
- Stage: Stage 6 - Issue #7 task 7-4 database deployment foundation

## Active work

- Issue: [#7](https://github.com/sysysysyb/AMUQ/issues/7)
- Branch: `feat/7-establish-app-foundation`
- Pull Request: None
- Plan: `docs/plans/2026-09-09-0037-feat-amuq-mvp-requirements-plan.md` / `docs/plans/2026-09-21-1633-docs-mvp-github-issues-plan.md`
- Design: [Final Screens](https://www.figma.com/design/iArpXyXjJ3rNCDP2QfU6s8/AMUQ?node-id=1032-9888) / [Prototypes](https://www.figma.com/design/iArpXyXjJ3rNCDP2QfU6s8/AMUQ?node-id=4-16)

## Current checkpoint

- Last completed: Implemented the 7-4 database deployment foundation and resolved all validated code-review findings.
- Latest verification: Frozen install, Drizzle generation check, format, lint, typecheck, Vitest (27 passed, 4 DB-skipped), integration (8 passed, 4 DB-skipped), build, and diff check — passed.

## Review focus

- `apps/api/src/db/migrations.ts::migrateDatabase` — advisory-lock ordering, bounded waits, and pg-boss BAM completion
- `apps/api/src/db/database.ts::assertDatabaseSchema` — exact Drizzle hash and pg-boss schema validation
- `.github/workflows/database.yml::integration` — PostgreSQL 17 migration, full validation, production readiness, and shutdown smoke

## Remaining risk

- PostgreSQL-backed migration and production smoke checks are configured for CI but could not run locally without `TEST_DATABASE_URL`.

## Blockers

- None

## Next action

- Owner: User
- Action: Review the committed 7-4 database deployment foundation and approve or request changes before 7-5.
