---
target: AMUQ Stage 3 Figma final screens and prototype
total_score: 21
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 5
target_identity: "url:https://www.figma.com/design/iArpXyXjJ3rNCDP2QfU6s8"
timestamp: 2026-09-09T08-02-39Z
slug: www-figma-com-design-iarpxyxjj3rncdp2qfu6s8
---
# AMUQ Stage 3 Figma critique

Method: dual-agent (A: `impeccable_assessment_a`, B: `impeccable_assessment_b`)

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3 | 생성 경로와 타이머는 좋지만 저장, 삭제, 진척 근거가 부족하다. |
| 2 | Match with the real world | 3 | 한국어는 자연스럽지만 릴레이와 일부 상태 의미가 모호하다. |
| 3 | User control and freedom | 2 | 뒤로가기와 나가기는 있으나 취소 및 되돌리기 계약이 약하다. |
| 4 | Consistency and standards | 3 | 컴포넌트는 응집돼 있지만 일부 통계 기간과 상태 용어가 요구사항과 다르다. |
| 5 | Error prevention | 1 | OCR 미해결 페이지와 확인 필요 문제가 남아도 다음 단계로 갈 수 있게 보인다. |
| 6 | Recognition rather than recall | 2 | 문제 검토에서 원본, 정답, 해설을 함께 볼 수 없어 기억에 의존한다. |
| 7 | Flexibility and efficiency | 1 | 다량의 초안을 위한 일괄 검토와 확정 가속 수단이 부족하다. |
| 8 | Aesthetic and minimalist design | 3 | 차분하고 간결하지만 일부 데스크톱 화면은 지나치게 비어 있다. |
| 9 | Error diagnosis and recovery | 2 | 부분 재시도는 좋지만 OCR, 검증 실패의 복구 경로가 부족하다. |
| 10 | Help and documentation | 1 | 고위험 결정에 필요한 문맥 도움과 행동 안내가 부족하다. |
| **Total** | | **21/40** | **Acceptable** |

## Design Specificity Verdict

구조는 AMUQ에 맞지만 시각 언어는 아직 범용 학습 SaaS와 교환 가능하다. 문제은행별 얇은 강조선, 단계형 생성 경로, 종이 같은 표면과 절제된 한국어 타이포는 제품에 잘 맞는다. 다만 AMUQ의 핵심 장면인 자료 변환, 검토, 확정과 삭제, 재학습 성과의 연결은 로그인 브랜드 패널만큼 강하게 드러나지 않는다.

자동 점검에서는 Final Screens의 컴포넌트 인스턴스 94개가 모두 로컬 원본에 연결되어 있고 변수 바인딩 636개, placeholder 0개, 프로토타입 연결 11개가 모두 유효했다. 모바일 고정 높이 컨테이너 여섯 곳의 잘림, 완료/예정 단계를 색에 의존해 구분하는 문제, 44px보다 작은 프로토타입 클릭 영역이 발견됐다. Figma URL은 CLI detector 대상이 아니며 DOM 오버레이도 적용할 수 없어 Figma 메타데이터, 스크린샷, Plugin API 읽기 검사로 대체했다.

## Overall Impression

차분하고 진지한 학습 도구라는 방향은 잘 잡혔다. 가장 큰 개선점은 장식을 늘리는 것이 아니라 AI가 자동으로 처리한 것, sy가 반드시 확인해야 하는 것, 되돌릴 수 없는 것을 더 엄격하게 구분하는 것이다.

## What's Working

- 문제은행 강조선과 생성 경로가 현재 맥락을 과장 없이 반복한다.
- 상태색에 텍스트 라벨을 함께 사용해 대부분 색상 단독 의존을 피했다.
- 데스크톱과 모바일의 정보 순서가 대체로 동일하며 단일 열 전환도 자연스럽다.
- Final Screens와 Prototype 모두 로컬 컴포넌트와 변수 연결이 끊기지 않았다.

## Priority Issues

### [P1] OCR 미해결 페이지의 차단 계약 부족

`확인 필요` 행, 원본 보기, 다른 챕터 지정, 제외, PDF 교체 동작을 제공하고 미해결 수가 0이 될 때까지 다음 단계 진입을 막아야 한다.

### [P1] 문제 확정에 필요한 검토 증거와 게이트 부족

원본 페이지, 정답, 해설을 함께 제공하고 오류 미해결 시 확정을 차단해야 한다.

### [P1] 승인된 학습 성과 모델 누락

재도전 정답 전환율, 미응답, 현재 오답, 북마크, 점수 추이, 취약 챕터와 승인된 기간 필터를 `현재 상태 → 변화 → 다음 행동` 순서로 보여줘야 한다.

### [P1] 프로토타입의 핵심 흐름 생략

업로드, 설정, 생성/부분 실패, 최종 확정, 제출/결과, 재개를 포함한 하나의 끊기지 않는 critical path가 필요하다.

### [P1] 모바일, 대비, 포커스 증거 부족

모바일 잘림을 제거하고, 44px 클릭 행, 완료 텍스트/아이콘, 강화된 보조색, visible focus 상태를 추가해야 한다.

## Persona Red Flags

- Jordan: `확인 필요`가 남았는데 완료 버튼이 활성화된 모순과 OCR 경고의 다음 행동 부재가 이탈 요인이다.
- Sam: 작은 텍스트 클릭 영역, 낮은 보조 텍스트 대비, 포커스 및 비동기 알림 설계 증거 부족이 위험하다.
- Casey: 하단 콘텐츠 잘림, 문제 검토의 스크롤 단서 부족, 시험 재개 흐름 미연결 때문에 중단 후 복귀가 어렵다.

## Minor Observations

- `중복 가능`과 `중복 가능성` 용어를 통일한다.
- 빈 문제은행의 `진행 중`, 문제 삭제의 `오류` 상태 어휘를 바로잡는다.
- 모바일 로그인에도 짧은 AMUQ 브랜드 문장을 유지한다.
- 큰 데스크톱 빈 공간은 향후 최근 이어하기 한 블록 정도로만 활용한다.

## Questions to Consider

- 학습 홈이 다섯 모드를 동등하게 보여주기보다 지금 이어서 할 한 가지를 먼저 제안하면 반복 학습률이 높아질까?
- sy가 직접 제외하지 않은 페이지가 하나라도 있다면 AMUQ는 다음 단계를 허용해야 하는가?
- 제품의 감정적 절정은 로그인 문구보다 원본 삭제와 첫 학습 준비 완료에 대한 확신이어야 하지 않을까?
