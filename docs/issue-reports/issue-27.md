# Issue #27 — Application Directory Rename

- 원본: [Issue #27](https://github.com/sysysysyb/AMUQ/issues/27)
- 현재: [PR #29](https://github.com/sysysysyb/AMUQ/pull/29) 병합과 Backend 3개 승인 커밋 완료. 누적 Issue CE 검토의 P3 1건과 추가 안내 관찰을 수정하고 최종 문서의 native 재검토 완료. 커밋 승인 대기. PR 게시는 미실행
- Issue 검토 기준: `99174c7a5399bd7a99f60317d31b8c4d4770c082`. 중간 PR 병합 후에도 유지

## Approved Delivery Order

| 순서       | 작업과 기록                                                                    | 상태                                                                                           |
| ---------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| PR1 / 27-1 | [Frontend 명칭과 실행 참조, 전달 규칙과 Preview 연결](issue-27/01-frontend.md) | PR #29 병합 완료                                                                               |
| PR2 / 27-2 | [Backend 명칭과 실행 참조 정리](issue-27/02-backend.md)                        | 제품 검증과 3개 승인 커밋 완료. 누적 검토 후 문서 수정과 최종 기록 재검토 완료, 커밋 승인 대기 |

- 방식: 작은 PR을 main에 순차 병합. PR2는 별도 승인 후 최신 main에서 준비했으며 최종 전달 조건 충족 후 `Closes #27` 사용 예정
- 각 PR: 독립 검토와 재검토 후 커밋, 게시와 병합의 개별 승인 게이트 유지

## Complete Issue Review

- 누적 CE 범위: 최초 기준부터 HEAD `22e290ee5ebf4dabc18be09effa61c353ced2be0`까지 PR1과 PR2의 11개 커밋. 9개 관점의 실제 결과와 공식 합성 및 독립 검증 완료
- 결과: `Ready with fixes`, P3 1건. 활성 MVP 계획의 backend 명칭 2곳 수정. 범위와 한계, 지적 처리 및 재검증은 [PR2 최종 검토 기록](issue-27/02-backend.md#final-issue-review)에 보존
- `ce-compound`: 명칭 누락은 단순 수정이며 기존 구현과 재사용 안내가 설명하는 내용을 중복하지 않도록 새 학습 문서 생략
- 최종 문서의 독립 재검토 완료. 정확한 변경에 대한 커밋 승인 대기

## Remaining Delivery Conditions

- 병합 기준: 최종 게시 HEAD의 CI와 Preview READY를 재확인하고 공통 고정 별칭을 해당 배포로 갱신. 자동화 최초 적용은 기존 수동 확인 유지
- 자동화 확인: 워크플로의 main 병합 후 다음 열린 PR의 Preview에서 실제 자동 실행과 토큰 권한 및 별칭 대상 대조 필요
- 토큰 범위: 게시 전에 Vercel이 허용하는 최소 권한인지 확인 필요. 실제 실행 권한의 확인은 게시 후 READY 검증에서 진행
- PR2의 별도 게시와 병합 승인 필요. 변경 후 검증 근거는 PR2 기록에 보존
- 누적 검토 후 최종 문서 재검토, 커밋 승인과 반영을 마친 뒤 별도 PR 게시 승인 필요
- MVP 전체 검토 기준 `mvp-start-sha`: 미확정. Stage 7 전에 최초 구현 이전 Git 이력으로 검증해 `docs/issue-reports/mvp-review-baseline.md`에 기록 필요. Issue 기준이나 현재 HEAD로 대체 금지
- 범위 제외: 테스트 관리는 [#28](https://github.com/sysysysyb/AMUQ/issues/28), SQL 포맷은 [#22](https://github.com/sysysysyb/AMUQ/issues/22)에서 진행 예정
