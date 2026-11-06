# Workflow Status

> Updated: 2026-11-07 01:50 KST

## Current state

- Status: awaiting approval
- Stage: Stage 6.3.2 — 27-2 분할 커밋 전달 기록 확정, 누적 Issue CE 검토 착수 승인 대기

## Active work

- Issue: [#27 Rename application directories to frontend and backend](https://github.com/sysysysyb/AMUQ/issues/27)
- Branch: `refactor/27-rename-backend`
- Pull Request: None
- Plan: [승인된 PR 순서](docs/issue-reports/issue-27.md)
- Design: None

## Current checkpoint

- Last completed: 사용자 승인 후 실행 변경 `86d909531c4a55a21bb2f86448009692cd5a22a3`와 경로 문서 `7f217f47ab9a89da170ac9f1ae381f648834a61b`를 분리 저장하고 PR2 전달 기록 확정
- Latest verification: 단위 179개, PostgreSQL 통합 148개, 별칭 41개와 E2E 84개 및 포맷, lint, 타입, 빌드 통과. Docker 기동과 정상 종료 및 정리 통과. Native 검토와 대상 재검토에서 지적 처리 및 최종화 수용

## Review focus

- None

## Remaining risk

- 고정 Preview 별칭 자동 실행과 등록 토큰 권한은 PR 게시 후 READY 배포에서 확인 필요

## Blockers

- None

## Next action

- Owner: User
- Action: 최초 Issue 기준부터 누적 CE 검토 착수 승인
