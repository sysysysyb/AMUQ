# Workflow Status

> Updated: 2026-09-26 01:22 KST

## Current state

- Status: review
- Stage: Stage 6 - Issue #7 Pull Request review

## Active work

- Issue: [#7](https://github.com/sysysysyb/AMUQ/issues/7)
- Branch: `feat/7-establish-app-foundation`
- Pull Request: [#21](https://github.com/sysysysyb/AMUQ/pull/21)
- Plan: `docs/plans/2026-09-09-0037-feat-amuq-mvp-requirements-plan.md` / `docs/plans/2026-09-21-1633-docs-mvp-github-issues-plan.md`
- Design: [Final Screens](https://www.figma.com/design/iArpXyXjJ3rNCDP2QfU6s8/AMUQ?node-id=1032-9888) / [Prototypes](https://www.figma.com/design/iArpXyXjJ3rNCDP2QfU6s8/AMUQ?node-id=4-16)

## Current checkpoint

- Last completed: Added the Korean-first Issue and Pull Request writing rule and updated Pull Request #21 to match it.
- Latest verification: Template Prettier check and `git diff --check` - passed; database integration and E2E await GitHub Actions PostgreSQL.

## Review focus

- `.github/pull_request_template.md::language guidance` - Korean-first Pull Request writing rule
- `.github/ISSUE_TEMPLATE/*.yml::language guidance` - matching Issue writing rule
- `Pull Request #21` - implementation report and CI result

## Remaining risk

- The complete PostgreSQL integration and E2E workflow remains unverified until GitHub Actions finishes.

## Blockers

- None

## Next action

- Owner: User
- Action: Review Pull Request #21 and its CI results, then approve or request changes.
