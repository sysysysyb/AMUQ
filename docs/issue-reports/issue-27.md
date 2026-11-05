# Issue #27 — 앱 디렉터리 명칭 정리

- 원본: [Issue #27](https://github.com/sysysysyb/AMUQ/issues/27)
- 현재: [PR #29](https://github.com/sysysysyb/AMUQ/pull/29) 게시. Frontend와 Preview 연결 및 실제 Google 로그인, 메일과 Webhook 검증 완료. 고정 별칭 자동화 추가 구현, 자동 실행 확인과 병합 미완료
- Issue 검토 기준: `99174c7a5399bd7a99f60317d31b8c4d4770c082`. 중간 PR 병합 후에도 유지

## 승인된 전달 순서

| 순서       | 작업과 기록                                                                                | 상태                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| PR1 / 27-1 | [Frontend 명칭과 실행 참조, 전달 규칙과 Preview 연결](issue-27/01-frontend.md)             | 기존 6개 커밋 게시와 실제 배포 검증 통과. 별칭 자동화 추가 구현                               |
| PR2 / 27-2 | Backend 폴더와 패키지 이동, `#api`와 `#api-test` 별칭 및 DB, worker, CI, Compose 경로 정리 | 미착수. 계획된 기록: `docs/issue-reports/issue-27/02-backend.md`. 최종 PR에 `Closes #27` 예정 |

- 방식: 작은 PR을 main에 순차 병합. PR2는 PR1 병합과 별도 착수 승인 후 최신 main에서 준비
- 각 PR: 독립 검토와 재검토 후 커밋, 게시와 병합의 개별 승인 게이트 유지

## 남은 전달 조건

- 병합 기준: 최종 게시 HEAD의 CI와 Preview READY를 재확인하고 공통 고정 별칭을 해당 배포로 갱신. 자동화 최초 적용은 기존 수동 확인 유지
- 자동화 확인: 워크플로의 main 병합 후 다음 열린 PR의 Preview에서 실제 자동 실행과 토큰 권한 및 별칭 대상 대조 필요
- PR1 병합 미실행. 병합은 별도 사용자 승인 대상
- 전체 Issue CE 검토: PR2 완료 후 최종 PR 게시 전에 최초 Issue 기준부터 누적 검토 예정
- MVP 전체 검토 기준 `mvp-start-sha`: 미확정. Stage 7 전에 최초 구현 이전 Git 이력으로 검증해 `docs/issue-reports/mvp-review-baseline.md`에 기록 필요. Issue 기준이나 현재 HEAD로 대체 금지
- 범위 제외: 테스트 관리는 [#28](https://github.com/sysysysyb/AMUQ/issues/28), SQL 포맷은 [#22](https://github.com/sysysysyb/AMUQ/issues/22)에서 진행 예정
