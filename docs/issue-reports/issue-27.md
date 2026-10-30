# Issue #27 — 앱 디렉터리 명칭 정리

- 원본: [Issue #27](https://github.com/sysysysyb/AMUQ/issues/27)
- 현재: frontend와 문서 규칙의 분할 커밋 완료, 결과 기록 확정. PR 게시 미승인
- Issue 검토 기준: `99174c7a5399bd7a99f60317d31b8c4d4770c082`. 중간 PR 병합 후에도 유지

## 승인된 전달 순서

| 순서       | 작업과 기록                                                                                | 상태                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| PR1 / 27-1 | [Frontend 명칭과 실행 참조, 준비된 AGENTS/status 전달 규칙](issue-27/01-frontend.md)       | 구현 검증과 문서 재검토 완료. `Refs #27` 예정                                                 |
| PR2 / 27-2 | Backend 폴더와 패키지 이동, `#api`와 `#api-test` 별칭 및 DB, worker, CI, Compose 경로 정리 | 미착수. 계획된 기록: `docs/issue-reports/issue-27/02-backend.md`. 최종 PR에 `Closes #27` 예정 |

- 방식: 작은 PR을 main에 순차 병합. PR2는 PR1 병합과 별도 착수 승인 후 최신 main에서 준비

## 남은 전달 조건

- PR1: 게시 전 Vercel 경로 전환 방식 확정, 병합 전 새 경로 배포 가능 조건 확인 필요
- 각 PR: 독립 검토와 재검토, 검증 및 커밋, PR 게시, 병합의 개별 승인 필요
- 전체 Issue CE 검토: PR2 완료 후 최종 PR 게시 전에 최초 Issue 기준부터 누적 검토 예정
- MVP 전체 검토 기준 `mvp-start-sha`: 미확정. Stage 7 전에 최초 구현 이전 Git 이력으로 검증해 `docs/issue-reports/mvp-review-baseline.md`에 기록 필요. Issue 기준이나 현재 HEAD로 대체 금지
- 범위 제외: 테스트 관리는 [#28](https://github.com/sysysysyb/AMUQ/issues/28), SQL 포맷은 [#22](https://github.com/sysysysyb/AMUQ/issues/22)에서 진행 예정
