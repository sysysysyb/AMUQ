# Workflow Status

> Updated: 2026-11-25 15:52 KST

## Current state

- Status: review
- Stage: Issue #28-3 API 통합 테스트 커밋 승인 대기

## Active work

- Issue: [#28 Define test organization standards and restructure existing suites](https://github.com/sysysysyb/AMUQ/issues/28)
- Branch: `refactor/28-split-api-integration-tests`
- Pull Request: None
- Plan: None
- Design: None

## Current checkpoint

- Last completed: PostgreSQL 통합 테스트 재배치와 Claude Code 대상 재검토 완료.
- Latest verification: PostgreSQL 통합 148개, Playwright 84개, Vitest 통합 외 179개, CI 도구 47개, 포맷, 린트, 타입 검사, 빌드 — passed.

## Review focus

- `apps/backend/test/support/database-fixture.ts::createTestDatabase` — DB 주소 검사와 정리 훅 범위 확인.
- `apps/backend/test/integration/auth-login-reservations.test.ts` — 별도 연결을 사용하는 동시 요청 검증 확인.
- `apps/backend/test/integration/email-outbox-claims.test.ts` — 발송 선점 및 만료 뒤 갱신 차단 검증 확인.

## Remaining risk

- PR 게시 뒤 CI에서 통합 케이스 이름과 실행 시간 비교 필요.

## Blockers

- None

## Next action

- Owner: User
- Action: 검토된 28-3 변경의 로컬 커밋 승인.
