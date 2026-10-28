# Workflow Status

> Updated: 2026-10-28 12:40 KST

## Current state

- Status: review
- Stage: Stage 6 — Issue #8 / PR4 구성과 검증 및 기록 확인 완료, 로컬 커밋 승인 대기

## Active work

- Issue: [#8](https://github.com/sysysysyb/AMUQ/issues/8)
- Branch: `chore/8-add-docker-preview`
- Pull Request: None
- Plan: [승인된 PR 순서](docs/issue-reports/issue-8.md), [U02](docs/plans/2026-09-09-0037-feat-amuq-mvp-requirements-plan.md)
- Design: None

## Current checkpoint

- Last completed: main `994f986` 기준으로 Docker 설정 4개 이관, 기록 지적 5건 수정과 재검토 완료. HTTPS E2E 84개와 검증용 CA 해제 확인, 최종 기록 확인 완료
- Latest verification: 새 이미지의 API 및 Next 빌드, 기동과 실제 HTTPS 로그인, 재시작 후 계정 유지, 일반 186개 및 HTTPS E2E 84개, 타입과 린트 및 포맷 — passed. DB 전용 137개는 일반 검사에서 생략

## Review focus

- `Dockerfile.preview` — 빌드 대상과 비밀 파일 제외
- `compose.preview.yaml` — DB 분리와 내부 API 비공개
- `docker/preview/Caddyfile` — 공개 HTTPS와 내부 HTTPS 전달

## Remaining risk

- DB pool과 요청 중 정리의 부하 및 운영 비용은 MVP 배포 직전 pool 1, 5, 10, 20 등으로 비교 예정

## Blockers

- None

## Next action

- Owner: User
- Action: PR4의 작업별 세 묶음 로컬 커밋 승인
