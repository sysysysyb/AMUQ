# 인증 메일 Webhook

Resend는 인증과 비밀번호 재설정 메일만 발송한다. 이 문서는 Issue #8의 전달 결과 수신 설정과 처리 계약을 설명한다.

## 설정

1. API 배포 전에 `pnpm db:migrate`로 새 스키마를 적용한다.
2. Resend에서 환경별 Webhook을 만들고 공개 HTTPS API 주소의 `/webhooks/resend`를 지정한다. 웹의 `/api` 프록시를 경유하지 않는다.
3. `email.delivered`, `email.bounced`, `email.complained`, `email.suppressed`를 구독한다. 열람과 클릭 추적은 끈다.
4. 해당 Webhook의 `whsec_` 서명 키를 API 서비스의 `RESEND_WEBHOOK_SECRET`에 설정한다. API 키와 Webhook 서명 키는 다르다. 테스트와 운영의 키를 공유하지 않는다.
5. API를 배포한 뒤 실제 테스트 메일과 Resend 대시보드에서 전달 결과를 확인한다. 현재 로컬 검증은 이 외부 확인을 대신하지 않는다.

운영 환경은 서명 키가 없거나 잘못되면 시작하지 않는다. 개발과 테스트에서는 키를 생략할 수 있으며 이때 수신 경로를 등록하지 않는다. 해당 Resend 환경에서 AMUQ 외의 발송을 섞지 않는다. 저장된 발송 ID가 없는 이벤트는 재시도 대상으로 처리한다.

## 요청 검증

`svix@2.8.0`이 JSON 변환 전의 원문과 `svix-id`, `svix-timestamp`, `svix-signature`를 검증한다. 이 버전의 `Webhook.verify()`는 값을 반환하지 않으므로 검증 성공 후 `JSON.parse()`를 호출한다. 본문 한도는 64 KiB이며 Svix의 기본 timestamp 허용 범위는 5분이다. 서버 시계를 동기화해야 한다.

브라우저 세션과 Origin은 요구하지 않는다. Webhook의 신뢰 경계는 서명, timestamp와 이벤트 ID다. 이벤트가 사용자 인증 상태를 변경하거나 메일을 다시 발송하지 않는다.

| 응답 | 의미 |
| --- | --- |
| `204` | 처리 완료, 중복 또는 지원하지 않는 이벤트 |
| `400` | 잘못된 서명, timestamp, 헤더 또는 이벤트 구조 |
| `413` | 본문 한도 초과 |
| `503` | DB 실패 또는 발송 ID가 아직 저장되지 않아 재시도 필요 |

Resend는 실패한 요청을 재시도한다. 발송 API 응답보다 먼저 도착한 이벤트는 ID를 저장하지 않고 `503`을 반환하므로 발송 결과 저장 후 다시 처리할 수 있다. 반복 실패로 Webhook이 비활성화되거나 재시도가 끝나면 운영자가 발송 ID와 설정을 확인하고 대시보드에서 재전송한다. [Resend 재시도 문서](https://resend.com/docs/webhooks/retries-and-replays)

## 저장과 상태 갱신

이벤트 ID는 기본 키로 중복을 차단한다. 발송 행 잠금, 이벤트 기록과 상태 갱신은 하나의 SQL 문에서 실행한다. 상태 갱신이 실패하면 이벤트 기록도 롤백된다.

| 이벤트 | 발송 상태 | 우선순위 |
| --- | --- | --- |
| `email.delivered` | `delivered` | 1 |
| `email.bounced` | `bounced` | 2 |
| `email.suppressed` | `failed`, 오류 코드 `resend_suppressed` | 2 |
| `email.complained` | `complained` | 3 |

낮은 우선순위의 이벤트는 상태를 덮어쓰지 않는다. 같은 우선순위에서는 발생 시각이 더 오래된 이벤트를 기록만 하고 상태에 반영하지 않는다. 따라서 늦게 도착한 전달 성공이 반송이나 신고 결과를 지우지 않는다.

`email_webhook_events`에는 이벤트 ID, 발송 행 ID, 이벤트 종류와 발생 및 수신 시각만 저장한다. 주소, 제목, 본문과 서명은 저장하거나 로그에 남기지 않는다. 발송 행이 삭제되면 관련 이벤트도 외래 키에 따라 삭제된다.

서명과 원문 검증의 제공자 계약은 [Resend 검증 문서](https://resend.com/docs/webhooks/verify-webhooks-requests)를 따른다. 라이브러리 사용법은 설치된 버전의 타입과 구현을 함께 확인한다.
