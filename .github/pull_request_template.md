<!-- Issue와 PR의 제목과 소제목은 영어, 본문은 간결하고 자연스러운 한국어로 작성. -->
<!-- PR 제목은 Feat: 등의 접두어를 유지하고 이모지는 제외. 커밋 제목의 Gitmoji는 유지. -->
<!-- PR을 만들 때 변경 종류와 범위에 맞는 라벨 적용. -->

## Outcome

- Closes # <!-- 여러 PR로 나누어 전달하는 중간 PR은 Refs # 사용. -->
- Requirement IDs:
- Records: <!-- 이 PR의 검토된 이슈 기록을 해당 커밋에 고정한 링크로 연결. -->

## Main changes

-

## Review focus

1. `path::symbol` — 역할과 반드시 지켜야 하는 조건

## Verification

- Test URL: [Preview 로그인](https://amuq-auth-preview-sys-projects-4849b575.vercel.app/login)
  <!-- Preview 테스트는 Vercel 자동 댓글의 브랜치 주소 대신 위 고정 주소 사용. 이 PR의 배포 연결 여부와 필요한 실행 조건을 함께 기재. 테스트 대상이 없으면 해당 없음으로 변경. -->

- [ ] 수정 전 실패와 수정 후 통과를 기록했음
- [ ] 관련 테스트를 실행하고 결과를 확인했음
- [ ] 타입 검사, 린트와 빌드를 통과했음
- [ ] 해당하는 주요 사용 흐름의 Playwright 테스트를 통과했음
- [ ] 화면 변경 시 브라우저 QA, Figma 대조와 Impeccable 검사를 완료했음
- [ ] 해당하는 권한, 동시 처리, 중복 실행 방지와 정리 검사를 통과했음

## Review findings

- Resolved:
- Deferred:

## Remaining risk

- 없음
