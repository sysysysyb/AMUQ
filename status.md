# Workflow Status

> Updated: 2026-11-04 14:10 KST

## Current state

- Status: awaiting approval
- Stage: Stage 6.3.1 — ngrok Preview 연결 보완의 커밋 승인 대기

## Active work

- Issue: [#27 Rename application directories to frontend and backend](https://github.com/sysysysyb/AMUQ/issues/27)
- Branch: `refactor/27` — PR 원격 연결은 기존 브랜치 유지
- Pull Request: [#29 Frontend 명칭과 전달 규칙](https://github.com/sysysysyb/AMUQ/pull/29)
- Plan: [승인된 PR 순서](docs/issue-reports/issue-27.md)
- Design: None

## Current checkpoint

- Last completed: HEAD `3adc070f3405ebc1912bea7511768de3b97ac2bb` 유지하며 브랜치 이름 변경, ngrok 외부 API와 로컬 production 프록시 연결 확인
- Latest verification: 신규 4개 사례 Red/Green, 단위 190개, API 통합 148개, E2E 84개와 lint, 타입 검사, 빌드 통과. 실행 파일 포맷과 별도 문서 검사 통과, 독립 검토 지적 4건 반영과 재검토 완료

## Review focus

- `compose.preview.ngrok.yaml` — 선택적 공개 터널 설정
- `apps/frontend/app/api/[...path]/route.ts` — ngrok 헤더와 기존 신뢰 경계
- `docs/issue-reports/issue-27/01-frontend.md` — 검증 범위와 남은 배포 조건

## Remaining risk

- Vercel에는 수정된 프록시가 미반영. 승인된 커밋과 배포 후 웹 Origin과 OAuth 설정을 함께 전환해야 실제 인증 확인 가능

## Blockers

- None

## Next action

- Owner: User
- Action: 검토된 ngrok 변경의 구성 추가와 프록시 보완 두 커밋 승인
