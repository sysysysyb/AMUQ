# Workflow Status

> Updated: 2026-11-26 14:40 KST

## Current state

- Status: awaiting approval
- Stage: Issue #28-4 커밋 승인 대기

## Active work

- Issue: [#28 Define test organization standards and restructure existing suites](https://github.com/sysysysyb/AMUQ/issues/28)
- Branch: `refactor/28-split-unit-and-provider-tests`
- Pull Request: None
- Plan: None
- Design: None

## Current checkpoint

- Last completed: 단위 테스트 분리, 외부 제공자 계약 이동과 줄 수 예외 제거. Claude 독립 검토와 대상 재검토 완료.
- Latest verification: Vitest 통합 외 179개, PostgreSQL 통합 148개, Playwright 84개, CI 도구 47개, 포맷, 린트, 타입 검사와 빌드 통과.

## Review focus

- `apps/backend/src/worker-lifecycle.test.ts` — 시작 실패와 종료 경합 검증의 보존 확인.
- `apps/backend/test/support/auth-http-server.ts::setupAuthHttpServer` — 파일별 서버 정리 범위 확인.
- `eslint.config.mjs::testFileLineRules` — 공통 줄 수 상한 적용 확인.

## Remaining risk

- 마지막 PR의 GitHub Actions에서 통합 외 179개의 이름과 통과 결과 대조 필요.

## Blockers

- None

## Next action

- Owner: User
- Action: 검토한 28-4 변경의 로컬 커밋 승인.
