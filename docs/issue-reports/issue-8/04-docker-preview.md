# Issue #8 / PR4 — Docker HTTPS preview

[Issue 목차](../issue-8.md)

## 결과와 검토 지점

- 개발 DB와 분리된 수동 preview 한 세트 구성. 웹, API, worker와 DB 구조 적용은 같은 앱 이미지의 서로 다른 명령으로 실행하도록 구성
- PostgreSQL과 Caddy는 별도 이미지와 컨테이너로 실행하며 DB 자료는 볼륨에 보존

| 파일                       | 책임과 확인할 조건                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `Dockerfile.preview`       | 웹, API와 worker를 실행할 앱 이미지 빌드. PostgreSQL 서버나 실행 중인 DB 자료는 포함하지 않음 |
| `compose.preview.yaml`     | 서비스, 네트워크와 볼륨 구성. 개발 DB와 프로젝트 이름 분리, 내부 API 포트 비공개 확인         |
| `docker/preview/Caddyfile` | 로컬 HTTPS와 웹, 내부 API 전달. 외부에서 내부 API를 직접 부를 수 없도록 구성                  |
| `.dockerignore`            | 비밀 환경변수와 로컬 인증서가 이미지에 포함되지 않도록 제외                                   |

- PR 번호는 아직 발급되지 않았으며 아래 번호는 승인된 분할 순서임
- 기존 로컬 커밋의 SHA는 과거 검토 참조임. 새 PR의 검토 HEAD와 병합 결과는 실제 게시 후 확인할 예정
- 아래 8-8과 기존 검증 절은 원본 작업 당시의 기록임. 새 이관 검증은 PR4 이관 절에 구분했음

## 8-8. Docker 로컬 preview — `a1a8906`

- **Codex 구현:** 웹, API, 메일 worker, DB 구조 적용 작업을 같은 앱 이미지로 실행하도록 구성했음. PostgreSQL과 Caddy는 각각 별도 공식 이미지 사용
  - **DB 분리:** 개발 DB와 preview DB의 프로젝트, 볼륨을 분리했음. 컨테이너를 중지, 재실행해도 계정이 유지되도록 구성했음
  - **접속:** 브라우저 → Caddy → 웹 서버 → 내부 Caddy → API 순서로 HTTPS 요청 전달. 외부에는 로컬 `4443` 포트만 공개하고 내부 API용 `8443`은 공개하지 않도록 수정했음
  - **비밀값:** `.env.preview`와 인증서를 Git, 이미지 빌드에서 제외했음. 웹에는 공개 인증서만 전달하고 개인 키는 전달하지 않도록 구성했음
  - **실행 모드:** 앱이 지원하는 `AMUQ_ENV=production` 사용. 개발 전용 Swagger UI는 열지 않도록 유지했음
- **Claude 검토:** Docker 프로젝트 이름 충돌 P2와 실행, 인증서, 설정 관련 P3 제시. 합동 후속 검토의 환경변수 검사 P1은 PR2 기록으로 이관했음
- **Codex 대응:** preview 프로젝트 이름 고정과 내부 API 직접 접근 차단. 관련 실패를 먼저 재현한 뒤 통과 확인했음
- **Claude 재검토:** Docker, 토스트를 함께 본 전체 18건의 처리와 최종 문구 확인했음. 마지막 검토에서 추가 지적 없었음
- **검증:** 이미지 빌드, DB 구조 적용, 서비스 시작 확인했음. HTTPS, API 상태, 요청 ID, Swagger 비공개, 잘못된 가입 요청 거절 검사 3개 통과
  - **사용자 확인:** 메일, 이메일 가입, 로그인, Google 로그인, 추가 인증 후 계정 연결, 컨테이너 재시작 후 계정 유지 확인했음
- **남은 작업:** Railway preview 삭제와 실제 외부 Resend Webhook 수신은 진행하지 않음. 모든 이전 공급자 키의 폐기 완료 여부도 별도로 확인하지 않음
  - **재빌드 주의:** Node 22, PostgreSQL 17, Caddy 2 계열 이미지를 사용했으며 세부 버전을 고정하지 않아 재빌드 결과가 달라질 수 있음

<details>
<summary>8-8 합동 리뷰 — DB 분리와 프록시 우회 방지</summary>

- **Claude 1차:** Docker와 토스트 합동 P2 1건, P3 9건 제시. Codex가 preview 프로젝트 이름과 내부 TLS 포트를 수정하고 실행 설명 보완
- **Claude 2차:** 합동 검토에서 예제 키 검사 P1과 검증 문구 P2 등을 추가 제시. P1의 수정과 기록은 PR2의 `8-8-R1`, 검증 문구 P2는 PR3의 `8-9-01`에 배정했음
- **Claude 3차:** 검사 시점과 최종 문구 P3 3건 추가 제시. 문서와 UTF-8/LF 출력 보완
- **Claude 4차:** 합동 18건 처리와 최종 문구 수용, 새 지적 없었음. PR3와 같은 합동 리뷰이며 아래는 Docker 관련 지적만 기록했음

| ID     | 등급 | Claude 지적과 Codex 처리                                                                                                                                                    |
| ------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8-8-01 | P2   | 기본 Compose 이름이 개발과 같아 postgres가 서로 교체될 수 있음 → preview 이름을 `amuq-preview`로 고정했음. 이전 실행은 이미 명시적 이름을 사용해 실제 개발 DB 교체는 없었음 |
| 8-8-02 | P3   | 외부 TLS 포트에서 내부 호스트로 요청하면 웹 프록시를 우회함 → 내부 API TLS를 공개하지 않는 8443으로 분리해 실패 후 통과 확인                                                |
| 8-8-04 | P3   | 첫 CA 추출과 신뢰 등록 순서가 추적 문서에 없음 → Windows 실행 순서와 중지, 인증서 갱신 절차 추가                                                                            |
| 8-8-05 | P3   | Node, PostgreSQL과 Caddy 세부 이미지 버전이 고정되지 않음 → 수동 로컬 preview의 한계로 유지. 앱 의존성은 잠금 파일 사용                                                     |
| 8-8-07 | P3   | CA 볼륨을 잃으면 이전 공개 인증서와 신뢰 설정이 남음 → 해당 인증서만 확인 후 신뢰 해제, 새 CA 등록과 웹 재생성 절차 추가                                                    |

개발 DB와 예제 환경변수의 P1 `8-8-R1`, 비밀번호 설명 P3 `8-8-03`, `8-8-06`은 해당 파일이 들어가는 [PR2 서버 기록](02-auth-server.md#개발-db와-환경변수-설정--8-8에서-이관)으로 이관했음. PR4에서는 그 설정을 사용하는 preview 서비스와 실행 방법을 다룸

검증 결과를 현재형으로 잘못 기록한 P2는 PR3의 8-9-01에 기록했음. 합동 완료 리뷰에서 P0 지적 없었음

</details>

## 기존 검증과 운영 기록

- 2026-10-23 세 수정이 포함된 이미지를 재빌드하고 기존 preview 볼륨으로 기동했음. API와 Next 프로덕션 빌드, HTTPS E2E 80개 통과. 새 외부 메일, Google 로그인과 재시작 검사는 실행하지 않음
- 기존 실제 확인에서 메일 수신, 이메일 가입과 로그인, Google 로그인과 추가 인증 후 계정 연결, 재시작 후 계정 유지 확인했음
- 개발 모드의 Google `503 provider_unavailable`은 설정 누락으로 확인했으며 이후 preview에서 실제 로그인 확인
- Railway preview 삭제, 모든 이전 공급자 키의 폐기와 실제 외부 Resend Webhook 수신은 확인하지 않음
- 2026-10-23 전체 CE 보고서 완료. PR3의 8-10 수정은 독립 재검토까지 완료했으며 해당 기록 시점에는 각 PR의 게시와 병합을 진행하지 않았음
- preview의 클라이언트 주소는 Docker 게이트웨이로 보일 수 있어 실제 사용자별 IP 제한 검증에 한계 있음. 로컬 전용 Playwright 설정으로 실행한 검사는 다른 클론에서 그대로 재현할 수 없음
- Caddy 인증기관의 개인키는 볼륨에 보관됨. preview를 완전히 제거할 때 해당 인증서의 Windows 신뢰 등록도 해제 필요

## PR4 이관 — 최신 main의 HTTPS 실행 구성

- **Codex 구현:** U02와 8-8의 원본 `3a5fae7`에 있는 Docker 구성을 PR3 병합 결과 `994f986`을 기준으로 이관했음. 원본 브랜치의 Docker 설정 4개 파일과 내용이 같으며 인증 서버와 화면 코드는 변경하지 않음.
  - **이미지:** 잠금 파일로 의존성을 설치하고 API와 Next를 함께 빌드했음. 비밀 환경값과 로컬 인증서는 빌드에 포함하지 않음.
  - **격리:** 기존 개발 DB와 preview를 보존하고 별도 검증 프로젝트와 새 볼륨을 사용했음. 내부 API에는 호스트 포트를 배정하지 않음.
  - **HTTPS:** 공개 Caddy 인증서를 웹에 전달해 내부 API 인증서를 확인하도록 구성했음. 공개 포트에 내부 API 호스트를 지정하면 빈 응답이 반환되며 API 상태 응답과 요청 ID는 노출되지 않음을 확인했음.
- **검증:** 새 이미지의 API와 Next 빌드, DB 구조 적용, API와 worker 및 웹 기동 통과. 인증서를 확인하는 HTTPS 상태 요청과 실제 비밀번호 로그인, Secure 및 HttpOnly 세션 쿠키 확인했음.
  - 일반 테스트 186개 통과, DB 전용 137개는 일반 검사에서 생략했음. 타입 검사와 린트, 포맷 통과.
  - 최초 일반 검사에서 기존 로그 검증 한 건이 5초 제한으로 실패했음. 이미지 빌드 완료 후 병렬 실행 수를 줄여 전체 재검사했으며 제품 코드와 테스트 제한 시간은 변경하지 않음.
  - 별도 DB에 만든 가상 계정으로 중지 전과 재실행 후 실제 로그인에 성공했음. 계정과 DB 자료 유지 확인.
  - 인증서 오류 무시 옵션을 끈 HTTPS 브라우저 E2E 84개 통과. 인증 화면 81개는 주로 모의 API 응답을 사용했으며 HTTP 검사 3개는 실제 API를 확인했음. 실제 비밀번호 로그인과 재시작 후 계정 유지는 별도 HTTPS 검사로 확인했음.
  - 검증 후 이번에 추가한 CA만 Windows 신뢰 저장소에서 해제하고 격리 프로젝트의 컨테이너를 중지했음. 기존 인증서와 개발 및 preview DB 볼륨은 보존했음.
- **Claude 검토:** Docker 설정 4개에 새 결함을 찾지 못했으며 기록의 시점과 출처 표현에 P2 1건, P3 4건을 제시했음. 원본 일치와 실행 검증은 제공된 자료로 확인했으며 Git 명령은 직접 실행하지 못했음.
- **Codex 대응:** 현재 상태와 역사적 검증을 구분하고 원본과 이관 기준을 명시했음. 시점이 바뀌면 틀리는 커밋 상태 문구를 제거하고 체크포인트를 실제 검증 상태로 갱신했음.
- **Claude 재검토:** 기록 지적 5건의 수정에 이어 HTTPS E2E 84개와 인증서 정리 결과를 반영한 최종 문구까지 확인했으며 추가 지적 없었음.
- **남은 위험:** 이미지의 세부 버전을 고정하지 않은 기존 한계와 Docker 게이트웨이 주소에 따른 실제 사용자별 IP 제한 검증의 한계를 유지함. 실제 Google 로그인, 새 외부 메일과 Webhook 수신은 이번에 다시 호출하지 않음.
- **학습 기록:** 기존 구현의 설정 이관으로 새 동작을 추가하지 않아 별도 해결 문서를 만들지 않음.

<details>
<summary>PR4 이관 검토 — 기록의 시점과 출처</summary>

| ID          | 등급 | Claude 지적과 Codex 대응                                                                                                        |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| PR4-PORT-01 | P2   | 목차의 커밋 전 상태가 게시 때 남을 수 있음 → 커밋 여부에 의존하는 문구 제거. 미완료 브라우저 검증과 게시 조건은 명시적으로 유지 |
| PR4-PORT-02 | P3   | 체크포인트가 빌드 진행 중으로 남음 → 완료된 빌드와 재시작 검증, CA 등록 대기를 실제 상태로 갱신                                 |
| PR4-PORT-03 | P3   | 과거의 테스트 미실행 설명과 새 검증이 혼재함 → 원본 당시 기록과 이번 이관 검증의 소속을 명시                                    |
| PR4-PORT-04 | P3   | 이관 출처와 대상 기준이 모호함 → 원본 `3a5fae7`과 대상 기준 `994f986`을 구분                                                    |
| PR4-PORT-05 | P3   | 목차가 PR2 문서를 이번 PR에 포함한 것처럼 설명함 → 각 문서가 포함된 실제 PR을 구분                                              |

- **Claude 재검토:** PR4-PORT-01부터 PR4-PORT-05까지의 처리와 최종 기록을 수용했으며 추가 지적 없었음.

</details>

## Docker preview 실행 참고

- 저장소 루트의 Windows PowerShell 기준으로 작성했음. 비밀값은 `.env.preview`에 별도 준비
  - `WEB_ORIGIN`은 `https://127.0.0.1:4443`, Google 콜백은 같은 주소의 `/api/auth/google/callback` 사용
  - `POSTGRES_PASSWORD`는 충분히 긴 난수를 영문, 숫자, 밑줄, 하이픈으로 준비. 현재 설정은 비밀번호를 DB URL에 직접 넣으므로 `@`, `:`, `/`, `#`, `%`는 사용하지 않도록 제한했음
  - 기존 DB의 비밀번호는 환경변수만 바꿔도 변경되지 않음. DB 역할의 실제 비밀번호와 설정을 함께 변경해야 함

```powershell
docker build -f Dockerfile.preview -t amuq-preview:local .
docker compose -f compose.preview.yaml --env-file .env.preview up -d --wait api worker proxy
docker compose -f compose.preview.yaml --env-file .env.preview cp proxy:/data/caddy/pki/authorities/local/root.crt docker/preview/local-ca.crt
Import-Certificate -FilePath docker/preview/local-ca.crt -CertStoreLocation Cert:\CurrentUser\Root
docker compose -f compose.preview.yaml --env-file .env.preview up -d --wait web
```

- 인증서와 이미지 준비 후 `docker compose -f compose.preview.yaml --env-file .env.preview up -d --wait`로 실행 가능. 중지는 같은 옵션 뒤에 `stop` 사용
  - `down`은 볼륨을 유지하지만 `down -v`는 DB 데이터도 삭제하므로 일반 중지, 인증서 갱신 용도로 사용하지 않도록 주의
- Node HTTPS 테스트는 공개 인증서를 `NODE_EXTRA_CA_CERTS`로 지정해야 함
- Caddy 인증서 볼륨을 잃으면 이전 인증서의 신뢰를 해제하고 새 공개 인증서를 복사, 등록한 뒤 `up -d --no-deps --force-recreate --wait web`으로 웹 재생성 필요
- preview를 더 이상 쓰지 않을 때도 해당 인증서만 신뢰 해제 가능. 아래 출력의 `Subject`, `Thumbprint`가 preview 인증서와 일치하는지 확인한 뒤 마지막 명령 실행 필요

```powershell
$previewCa = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path docker/preview/local-ca.crt).Path)
$previewCaPath = "Cert:\CurrentUser\Root\$($previewCa.Thumbprint)"
Get-Item -LiteralPath $previewCaPath | Select-Object Subject, Thumbprint
Remove-Item -LiteralPath $previewCaPath
```
