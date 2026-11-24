# Workflow Status

> Updated: 2026-11-24 19:29 KST

## Current state

- Status: awaiting approval
- Stage: Issue #28-2 커밋 승인 대기

## Active work

- Issue: [#28 Define test organization standards and restructure existing suites](https://github.com/sysysysyb/AMUQ/issues/28)
- Branch: `refactor/28-split-e2e-tests`
- Pull Request: None
- Plan: None
- Design: None

## Current checkpoint

- Last completed: E2E 84개 분리, 줄 수 예외 정리 및 독립 검토와 대상 재검토 완료.
- Latest verification: 이동한 6개 파일 단독 및 전체 E2E 84개 기본과 1 worker 재실행, Vitest 179개, CI 도구 47개, PostgreSQL 통합 148개 및 포맷, 린트, 타입 검사, 빌드 — passed.

## Review focus

- `tests/e2e/auth-password-reset-email.spec.ts` — 이메일 형식 검사를 해당 사용자 흐름에 배치.
- `tests/e2e/signup-completion.spec.ts` — 가입 완료 흐름에서 인증 만료와 서버 시간 검증 보존.
- `.github/scripts/check-test-organization.test.mjs` — 정확한 경로에만 예외가 적용되도록 검사.

## Remaining risk

- PR 게시 후 CI에서 동일한 E2E 케이스와 동시 실행 결과를 대조해야 함.

## Blockers

- None

## Next action

- Owner: User
- Action: 검토한 28-2 변경의 로컬 커밋 승인.
