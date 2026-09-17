---
target: Final Screens — Revised (right-side drafts excluded)
total_score: 32
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 0
target_identity: "url:https://www.figma.com/design/iArpXyXjJ3rNCDP2QfU6s8/AMUQ"
timestamp: 2026-09-17T07-20-07Z
slug: www-figma-com-design-iarpxyxjj3rncdp2qfu6s8-amuq
---
Method: dual-agent (A: /root/ultimate_final_assessment_a · B: /root/ultimate_final_assessment_b)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3 | 생성·답변·시간·오류 상태는 명확하지만 긴 10/5문항 페이지에서 상단 진행 정보가 스크롤 밖으로 사라진다. |
| 2 | Match System / Real World | 4 | 문제 초안, 미응답, 취약 챕터, 모의고사 등 수험자가 이해하는 언어와 순서가 자연스럽다. |
| 3 | User Control and Freedom | 3 | 뒤로가기, 중단, 재시도, 검토 복귀가 있으나 긴 테스트와 중복 비교의 빠른 위치 이동은 약하다. |
| 4 | Consistency and Standards | 4 | 전역 초록과 문제은행 파랑, 반응형 컴포넌트, 인증 상태명이 일관된다. |
| 5 | Error Prevention | 3 | 미응답·시간 만료·삭제 경고가 좋지만 일괄 삭제 범위와 모바일 차트 hit area는 구현 계약이 더 필요하다. |
| 6 | Recognition Rather Than Recall | 3 | 상태 배지와 정오답 표시는 명확하나 긴 중복 비교에서는 첫 문제를 기억하며 두 번째를 읽어야 한다. |
| 7 | Flexibility and Efficiency | 3 | 10/5문항 묶음과 일괄 작업은 효율적이지만 문항 점프·키보드 가속 경로는 아직 없다. |
| 8 | Aesthetic and Minimalist Design | 3 | 절제되고 읽기 쉽지만 긴 테스트·비교 화면은 카드 반복과 세로 이동이 단조롭다. |
| 9 | Error Recovery | 3 | 이메일 실패와 Google 취소가 분리되고 복구 문구도 구체적이나 Google 취소의 빨간 실패 표현은 과하다. |
| 10 | Help and Documentation | 3 | 단계별 안내와 상태 화면은 충분하나 복잡한 검토 결정의 맥락 도움말은 제한적이다. |
| **Total** | | **32/40** | **Good — prototype-ready with bounded P2/P3 follow-ups** |

## Design Specificity Verdict

**LLM assessment:** 제품 흐름은 AMUQ에 특화됐고 시각 문법은 절제된 범용 학습 SaaS에 가깝다. PDF 추가 → 구조 확인 → AI 생성 → 중복 비교·삭제 → 전체 확정 → 테스트 → 오답 재학습 → 기록의 구조, 출처 페이지, 6단계 생성, 원본 삭제 고지는 제품 고유성이 높다. 반면 흰 카드, 얇은 테두리, 넓은 여백, 단색 CTA는 다른 SaaS에도 옮길 수 있다. 현재의 진지하고 신뢰 중심인 방향에는 적절하며, 고유성은 장식보다 작업 구조와 카피에서 발생한다.

**Deterministic scan:** URL 대상이어서 CLI detector는 규칙에 따라 건너뛰었다. Figma MCP 구조·렌더·Plugin API 검증에서는 인증 화면 분리, 14개 진행률 비율, 6개 다이얼로그 배경, 모바일 Stepper, 테마 구분, 12개 차트 포인트 툴팁 명세가 모두 통과했다. 대상 텍스트 4,211개 중 Pretendard 4,201개, Roboto 8개였고 Roboto는 모두 의도된 Google 로그인 버튼이었다.

**Visual overlays:** 새 브라우저 세션으로 Figma URL 접근을 시도했지만 CloudFront 403으로 편집기 캔버스에 도달하지 못했다. 따라서 신뢰할 수 있는 사용자 표시 overlay는 없으며, Figma MCP screenshot·metadata·design context와 읽기 전용 Plugin API 순회를 대체 근거로 사용했다.

## Overall Impression

최종 수정본은 전역/문제은행 테마, 테스트 페이지 수, 진행률, 다이얼로그 맥락, 인증 오류 분리, 학습 기록 축까지 하나의 제품 규칙으로 정리됐다. 이제 가장 큰 기회는 정적 화면을 더 늘리는 것이 아니라 프로토타입에서 긴 10/5문항 흐름과 차트 포인트의 실제 상호작용을 검증하는 것이다.

## What's Working

1. **학습 방식이 의도대로 분리됐다.** 미니테스트·모의고사는 데스크탑 10문항/모바일 5문항 묶음이며, 한 문제씩 진행하는 방식은 릴레이 테스트에만 남았다.
2. **상태와 맥락의 연결이 촘촘하다.** 이메일 로그인 실패와 Google 취소, 미응답·시간 만료, Last Page 배경, 정확한 진행률이 서로 맞는다.
3. **테마와 타이포그래피가 안정적이다.** 전역 초록, 정보처리기사 파랑이 역할별로 구분되고 비-Pretendard는 의도된 Google 로그인 Roboto만 남았다.

## Priority Issues

### [P2] 차트 툴팁에 모바일 tap 계약이 없다

- **Why it matters:** 현재 12개 포인트에는 hover와 keyboard focus, `YYYY. MM. DD HH:mm` 형식이 기록됐지만 모바일에는 hover가 없다. 보이는 점도 약 5–18px라 직접 터치하기 어렵다.
- **Fix:** 프로토타입에서 tap으로 열고 바깥 tap·재tap·Esc로 닫도록 연결한다. 시각적 점 크기는 유지하되 최소 44×44px 투명 hit area, focus ring, 스크린리더 이름을 둔다.
- **Suggested command:** `$impeccable harden`

### [P2] 긴 10/5문항 페이지에서 현재 위치를 잃기 쉽다

- **Why it matters:** 페이지당 문항 수는 사용자 의도에 맞지만, 중간까지 스크롤하면 답변 수와 진행 바, 제출 위치가 화면 밖으로 사라진다.
- **Fix:** 문항 수를 바꾸지 않고 축약형 sticky 상태 바에 `답변 n/전체`, 현재 문제 범위, 미응답 위치 이동을 제공한다. 한 문제씩 넘기는 흐름은 추가하지 않는다.
- **Suggested command:** `$impeccable adapt`

### [P2] Google 로그인 취소가 실패보다 강한 오류로 보인다

- **Why it matters:** 화면명과 본문은 분리됐지만 빨간 실패 블록은 사용자의 의도적 취소도 잘못으로 느끼게 한다.
- **Fix:** `Google 로그인이 취소되었습니다`를 중립 안내 색으로 표현하고 `다시 시도`를 제공한다. 빨강은 실제 인증 실패에만 사용한다.
- **Suggested command:** `$impeccable clarify`

### [P3] 완료 Stepper 숫자의 내부 구조가 다른 단계와 다르다

- **Why it matters:** 현재 렌더는 정상이나 완료 1–3은 절대 배치 오버레이, 4–6은 Marker 내부 텍스트라 컴포넌트 수정 시 위치가 다시 어긋날 위험이 있다.
- **Fix:** 프로토타입 구현 시 모든 단계 숫자를 동일한 Marker 내부 구조로 만든다. 시각 디자인을 다시 바꿀 필요는 없다.
- **Suggested command:** `$impeccable harden`

## Cognitive Load

체크리스트 실패는 3/8로 중간 수준이다. `Duplicate Compare`에서 두 긴 문제와 여러 처리 행동이 한 화면에 공존하고, 모바일은 첫 문제를 기억한 채 두 번째와 하단 결정을 봐야 한다. 4개 초과 선택 지점은 전역 홈의 문제은행 6개+생성 CTA, 검토 화면의 다수 선택 대상, 중복 비교의 처리·이동 행동이다. 테스트의 답안 네 개는 익숙한 시험 문법이라 과부하로 보지 않았다.

## Emotional Journey

랜딩은 “내 자료가 오늘 풀 문제로”라는 효익으로 신뢰를 만들고, 생성 6단계와 출처 확인은 AI 불확실성을 통제하는 감각을 준다. 피로의 저점은 긴 검토·비교와 10/5문항 스크롤이다. 미응답·시간 만료·원본 삭제 경고와 Last Page 배경은 고위험 순간을 침착하게 설명한다. 결과 화면의 점수·정오답·다음 학습 CTA는 좋은 peak-end다.

## Persona Red Flags

- **Alex — 숙련 사용자:** 10/5문항 페이지와 중복 비교에서 문항 점프·키보드 가속 경로가 없어 반복 작업 시간이 길어진다.
- **Sam — 키보드·보조기술 사용자:** 차트 포인트의 focus 명세는 있으나 실제 focus ring, 접근 가능한 이름, 44px hit area, 모바일 tap 상태는 아직 프로토타입에서 확인해야 한다.
- **Casey — 이동 중 모바일 사용자:** 진행 정보가 최상단, 다음 행동이 최하단이라 앱 전환 후 현재 위치 복구가 어렵다. 차트 툴팁도 tap 동작 없이는 접근할 수 없다.

## Minor Observations

- 학습 기록의 Y축 60/70/80%와 날짜 라벨은 추세 해석을 개선했다. 툴팁이 실제로 동작하면 정보 밀도도 적절하다.
- 데스크탑 테스트 화면의 넓은 좌우 여백은 읽기 폭에는 유리하며, 향후 문항 내비게이션을 추가할 여지를 제공한다.
- 결과 화면은 정답·오답·미응답을 색뿐 아니라 텍스트와 아이콘으로도 구분한다.
- 오른쪽 초안 `1032:14112`, 왼쪽 대안 `1032:15118`, hidden/deprecated, 원본 `4:15`, Prototype `4:16`은 평가에서 제외했다.

## Questions to Consider

1. 프로토타입에서 차트 툴팁을 desktop hover/focus와 mobile tap까지 완성할지, 우선 desktop 동작만 연결할지?
2. 10/5문항 규칙을 유지하면서 위치 복구 장치를 축약 sticky 상태 바로 둘지, 문항 번호 지도로 둘지?
3. Google 취소를 중립 안내로 조정할지, 현재의 빨간 실패 시각을 유지할지?
