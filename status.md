# Workflow Status

> Updated: 2026-09-25 02:24 KST

## Current state

- Status: review
- Stage: Stage 6 - Issue #7 task 7-7 trusted proxy boundary

## Active work

- Issue: [#7](https://github.com/sysysysyb/AMUQ/issues/7)
- Branch: `feat/7-establish-app-foundation`
- Pull Request: None
- Plan: `docs/plans/2026-09-09-0037-feat-amuq-mvp-requirements-plan.md` / `docs/plans/2026-09-21-1633-docs-mvp-github-issues-plan.md`
- Design: [Final Screens](https://www.figma.com/design/iArpXyXjJ3rNCDP2QfU6s8/AMUQ?node-id=1032-9888) / [Prototypes](https://www.figma.com/design/iArpXyXjJ3rNCDP2QfU6s8/AMUQ?node-id=4-16)

## Current checkpoint

- Last completed: Implemented and re-reviewed the authenticated Web-to-API client-address boundary.
- Latest verification: Focused proxy tests (26 passed), format, lint, typecheck, full Vitest, integration, build, and diff check - passed; local E2E startup requires a database URL.

## Review focus

- `apps/api/src/http/client-address.ts::resolveClientAddress` - authenticated address validation and socket fallback
- `apps/web/app/api/[...path]/route.ts::proxy` - caller-header replacement and HTTPS-only production forwarding
- `apps/api/test/integration/health.test.ts::HTTP foundation` - spoofing and malformed-address coverage through the real server wiring

## Remaining risk

- Vercel and Railway must receive the same strong `PROXY_SHARED_SECRET`; preview must verify the accepted address end to end before rate limiting uses it.

## Blockers

- None

## Next action

- Owner: User
- Action: Review the committed 7-7 trusted proxy boundary and approve or request changes before 7-8.
