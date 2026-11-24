# Workflow Status

> Updated: 2026-11-24 15:13 KST

## Current state

- Status: awaiting approval
- Stage: Issue #28-1 커밋 승인 대기

## Active work

- Issue: [#28 Define test organization standards and restructure existing suites](https://github.com/sysysysyb/AMUQ/issues/28)
- Branch: `chore/28-define-test-standards`
- Pull Request: None
- Plan: None
- Design: None

## Current checkpoint

- Last completed: 테스트 구성 기준과 CI 검사 구현, 독립 검토와 대상 재검토 완료.
- Latest verification: CI 도구 테스트 47개, Vitest 179개, PostgreSQL 통합 148개, 포맷, 린트, 타입 검사 및 빌드 — passed.

## Review focus

- `docs/TESTING.md::줄 수를 정한 이유` — 후보 상한과 기존 테스트 분포를 비교한 근거.
- `eslint.config.mjs::testLineLimitExceptions` — 기존 초과 파일에 적용하는 정확한 경로와 허용 길이.
- `.github/workflows/database.yml` — 테스트 구성 검사와 개별 케이스 출력.

## Remaining risk

- 28-1 게시 후 GitHub Actions에서 개별 테스트 목록 확인 필요.

## Blockers

- None

## Next action

- Owner: User
- Action: 현재 Issue #28-1 변경의 로컬 커밋 승인.
