# 테스트 구성 기준

- 실패한 동작을 파일 이름으로 찾고 해당 파일을 단독 실행해 재현할 수 있도록 구성. 새 회귀 테스트는 같은 사용자 흐름이나 서버 계약을 검증하는 파일에 추가.
- 파일의 책임을 한 문장으로 설명할 수 있게 유지. 서로 다른 사용자 흐름이나 서버 계약이 섞이면 줄 수와 관계없이 파일을 나눔.

## 테스트 위치 결정

| 유형             | 배치와 분리 기준                                                                                                                                                                          | 예시                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 브라우저 E2E     | `tests/e2e/`에서 사용자 흐름별로 구성. 응답을 모의하는 화면 검사와 프록시를 통해 실제 API를 호출하는 검사는 파일로 구분                                                                   | 로그인과 가입, 비밀번호 재설정, Google 계정 연결, 공통 피드백, 접근성, 실제 `/api` 연동 |
| 단위와 컴포넌트  | `apps/` 또는 `packages/`의 대상 모듈 가까이에 배치. 같은 함수, 컴포넌트나 실행 계약을 검증하는 사례를 함께 둠                                                                             | 인증 오류 메시지, 공통 입력 필드, worker 시작과 종료                                    |
| API 통합         | `apps/backend/test/integration/`에서 DB, API 또는 worker 연동이 필요한 서버 계약별로 구성                                                                                                 | migration, DB 제약, outbox 전달, 로그인 제한, 가입 수명 주기                            |
| 외부 제공자 계약 | 새 테스트는 `apps/backend/test/contracts/`에 배치. 요청, 응답, 서명과 오류 처리를 제공자별로 구성                                                                                         | Google OIDC 토큰 검증, Resend 발송과 webhook 규약                                       |
| 공유 지원 코드   | 개별 앱이나 패키지의 루트 바로 아래 `test/support/` 또는 `test/fixtures/`에 배치. E2E와 CI 도구의 지원 코드는 각각 `tests/e2e/`와 `.github/scripts/`의 `support/` 또는 `fixtures/`에 배치 | 테스트 DB 주소 검사, 테스트 데이터 생성, 정리, 반복되는 모의 응답 준비                  |

- 새 회귀는 기존 흐름에 추가. 예를 들어 재설정 세션 만료는 재설정 파일에 두고, 여러 화면에서 쓰는 공통 피드백 동작은 별도 파일로 분리.
- 두 곳 이상에서 같은 의미로 반복되는 준비와 정리만 공유. 테스트에서 수행한 행동과 핵심 결과 검증은 본문에 유지.
- 검증 자체에 순서나 동시 요청이 필요하면 함께 유지. 예를 들어 토큰을 두 요청이 동시에 소비할 때 하나만 성공한다는 계약은 한 테스트에서 재현하고 결과를 확인. [분리 전 토큰 경합 테스트](https://github.com/sysysysyb/AMUQ/blob/5f9d524cdae5253725e2629b29432db920ccb79c/apps/backend/test/integration/database.test.ts#L232)

## 줄 수와 예외

| 대상                                | 기준                    | 적용 이유                                                                       |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| E2E, 단위, 컴포넌트, CI 도구 테스트 | 파일당 400줄 이하       | 흐름이나 모듈의 실패를 한 파일 안에서 찾을 수 있도록 크기를 관리                |
| API 통합, 외부 제공자 계약          | 파일당 500줄 이하       | DB 준비, 정리, 여러 요청의 관계와 외부 응답 예시를 함께 읽을 여유 확보          |
| 공유 지원 코드                      | 파일당 250줄 이하       | 지원 코드가 여러 동작을 대신 수행하거나 검증을 감추는 지점으로 커지기 전에 발견 |
| 단일 테스트                         | 100줄부터 리뷰에서 검토 | 독립된 검증이 섞였는지와 여러 단계가 같은 결과를 증명하는 데 필요한지 확인      |

- 파일 상한은 import, 주석, 공백, 파일 안의 테스트 데이터를 모두 포함한 물리적 줄 수로 검사. `pnpm lint`의 ESLint `max-lines`가 파일과 실제, 허용 줄 수를 표시. [ESLint 설정](../eslint.config.mjs), [CI 설정](../.github/workflows/database.yml)
- Vitest는 `apps/`와 `packages/`의 `.test.ts`, `.test.tsx`, Playwright는 `tests/e2e/`의 `.spec`과 `.test`를 발견. 해당 파일은 지원 코드와 같은 폴더에 있어도 테스트 유형의 상한을 적용. 테스트 러너의 파일 수집 규칙을 바꾸는 PR은 ESLint의 적용 경로도 함께 확인. [Vitest 설정](../vitest.config.ts), [Playwright 설정](../playwright.config.ts)
- 테스트와 공유 지원 파일의 인라인 ESLint 설정은 비활성화.
- 예외는 ESLint 설정에 정확한 파일 경로와 허용 길이를 등록하고 PR 리뷰에서 사유, 범위와 해소 조건을 승인받음. [현재 예외](../eslint.config.mjs)
- 파일을 줄이면 예외 상한을 실제 길이로 낮춤. 기본 상한 이내로 줄이거나 파일을 삭제하면 예외를 제거. CI에서 길이나 경로가 맞지 않는 예외를 검출.
- 로컬에서 줄 수 검사만 확인하려면 `node --test .github/scripts/check-test-organization.test.mjs` 실행. CI와 같이 도구 테스트 전체를 실행하려면 `node --test ".github/scripts/**/*.test.mjs"` 사용. [검증 규칙 테스트](../.github/scripts/check-test-organization.test.mjs)
- 분리 시 기존 결과 검증, 기대값과 실행 조건을 보존. 검증을 옮기거나 생략해 상한을 맞추기 전에 파일의 책임을 실제로 나눌 수 있는지 확인.

## 줄 수를 정한 이유

- `5f9d524`의 추적 파일에 후보 상한을 적용해 어떤 코드가 분리 검토 대상에 들어오는지 확인. 측정값은 AMUQ의 시작 기준을 고르는 데 사용. 파일은 맡은 동작을 기준으로 배치하며, 짧은 파일도 다른 계약이 섞이면 분리.
- **파일 400줄.** 단위와 컴포넌트 파일 22개 중 300줄에서는 4개, 400줄에서는 2개, 500줄에서는 1개가 초과. 400줄이면 `worker`와 인증 `routes` 두 파일을 우선 검토할 수 있음.
- E2E는 세 후보값 모두 `auth-ui`와 `signup-ownership` 두 파일이 초과. 단위와 컴포넌트 및 CI 도구 테스트와 같은 상한을 적용.
- **500줄**은 API 통합 13개 중 길이가 가장 큰 6개를 우선 살피도록 선택. 400줄이면 Google 인증 486줄과 health 452줄도 초과. DB 상태, 여러 요청의 관계와 정리 코드를 한 계약에서 함께 읽을 여유를 둠. 기존 외부 제공자 계약 3개는 모두 243줄 이하였으며, 토큰, 서명, 응답 예시와 검증을 함께 읽을 수 있도록 같은 여유를 적용.
- **250줄**은 반복 준비, 정리를 위한 파일이 테스트 묶음만큼 커지기 전에 검토하는 기준. 기준 시점의 백엔드 `test/support/`에서 테스트를 제외한 3개는 17, 36, 148줄. 현재 가장 긴 helper에도 여유를 주고, 준비 코드가 여러 흐름이나 핵심 검증을 떠맡게 되는 변경은 리뷰에서 확인.
- **단일 테스트 100줄.** 기준 시점 Playwright와 Vitest의 테스트 선언 332개 중 80줄 이상 18개, 100줄 이상 10개, 120줄 이상 8개 확인. 100줄이면 80줄 기준보다 검토 대상은 8개 적고, 120줄 기준에서 빠지는 2개도 살필 수 있음. 매개변수를 바꿔 반복 실행하는 사례는 선언 한 건으로 계산.
- 한 동작을 증명하는 연속 단계는 함께 유지. 예를 들어 212줄인 로그인 알림 테스트를 검토할 때는 각 단계가 문구 변경과 화면 반응을 검증하는 데 필요한지 확인. [분리 전 로그인 알림 테스트](https://github.com/sysysysyb/AMUQ/blob/5f9d524cdae5253725e2629b29432db920ccb79c/tests/e2e/auth-ui.spec.ts#L392)
- 상한을 조정하는 PR에는 새 기준이 영향을 주는 파일, 구분되는 책임과 한 파일에 남겨야 할 검증을 기록. 같은 책임의 예외가 반복되면 개별 예외를 늘리기 전에 상한과 배치 기준을 함께 재검토.

## 파일 이동 검증

- 변경 전후 테스트 러너가 등록한 파일, 묶음, 케이스 이름과 브라우저 프로젝트를 기록. 경로나 이름이 달라졌으면 기존 케이스의 새 위치를 대조해 누락과 중복을 확인. Playwright는 `pnpm test:e2e --list`, Vitest 5는 `pnpm exec vitest list --no-static-parse`에 실제 실행과 같은 필터와 환경을 적용. [Playwright CLI](https://playwright.dev/docs/test-cli), [Vitest CLI](https://vitest.dev/guide/cli.html#vitest-list)
- 로컬과 CI 각각의 커밋, OS, 도구, 브라우저, DB 버전, 실행 명령과 DB 준비 순서를 기록. 실제 통과, 실패, 건너뜀, 재시도 건수와 시간을 확인. 실제 PostgreSQL 통합은 `pnpm test:integration`으로 실행하고, E2E 전에 테스트 DB에 migration을 다시 적용. [CI 실행 순서](../.github/workflows/database.yml)
- 이동한 파일을 단독 실행한 뒤 전체 테스트 묶음을 실행. 결과 검증과 timeout, 준비, 정리 훅, 쿠키, 요청 가로채기, 모의 시계와 DB 상태를 대조해 실행 순서에 의존하는 사례가 없는지 확인.
- E2E 파일 분리 전후 기본 실행과 `pnpm test:e2e --workers=1`의 결과, 시간 및 러너가 보고한 worker 수를 비교. 파일 수가 달라지면 동시 실행이 늘어 공유 서버나 DB에 영향을 줄 수 있음. [Playwright 병렬 실행](https://playwright.dev/docs/test-parallel)
- Vitest의 `fileParallelism: false`와 공유 DB 조건은 격리 증명과 승인 전까지 유지. DB 주소 검사, rollback, pool 종료와 기존 경합 검증을 보존. [Vitest 파일 병렬화](https://vitest.dev/config/fileparallelism)

## 기준의 출처

- Playwright는 페이지 동작과 브라우저 수명 주기, 테스트 러너를 검증 대상과 필요한 준비 도구로 구분. AMUQ의 모의 API 화면 검사와 실제 API 연동 검사 분리에 반영. [Playwright 테스트 배치 기준](https://github.com/microsoft/playwright/blob/main/AGENTS.md#test-directories-and-fixtures)
- Next.js는 같은 기능의 기존 묶음에 회귀를 추가하고 실행마다 파일과 포트를 격리. AMUQ의 회귀 배치와 파일 이동 뒤 단독 실행 기준에 반영. [Next.js 테스트 기여 가이드](https://github.com/vercel/next.js/blob/canary/contributing/core/testing.md#best-practices)
- Immich는 단위, 통합, API E2E와 브라우저 검사를 별도 명령으로 실행하고 Playwright 프로젝트별 병렬 실행 조건을 둠. AMUQ의 테스트 경계와 worker 실행 조건을 기록하는 기준에 반영. [Immich 테스트 안내](https://github.com/immich-app/immich/blob/main/docs/docs/developer/devcontainers.md#running-tests), [Immich Playwright 설정](https://github.com/immich-app/immich/blob/main/e2e/playwright.config.ts)
- 줄 수는 Issue #28에서 정한 프로젝트 기준. 공개 사례는 테스트를 어디에서 실행하고 무엇을 함께 검증할지 판단하는 데 참고. [Issue #28](https://github.com/sysysysyb/AMUQ/issues/28), [ESLint `max-lines`](https://eslint.org/docs/latest/rules/max-lines)
