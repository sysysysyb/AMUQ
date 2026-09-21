---
target: AMUQ Stage 3 revised Figma final screens and prototype
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 5
target_identity: "url:https://www.figma.com/design/iArpXyXjJ3rNCDP2QfU6s8"
timestamp: 2026-09-09T08-43-16Z
slug: www-figma-com-design-iarpxyxjj3rncdp2qfu6s8
---
# AMUQ Stage 3 수정본 Figma critique

Method: dual-agent (A: `postfix_assessment_a`, B: `postfix_assessment_b`)

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3 | 단계, 부분 실패, 타이머가 명확하지만 재개 상태가 홈에 통합되지 않았다. |
| 2 | Match with the real world | 3 | 학습 용어는 자연스럽지만 확정 전 `진행 중` 표현이 부정확하다. |
| 3 | User control and freedom | 2 | 재시도, 나가기, 계정 삭제 취소는 있으나 영구 삭제와 제출 취소 계약이 부족하다. |
| 4 | Consistency and standards | 2 | Final과 Prototype의 통계, 기간, 학습 모드 연결이 서로 다르다. |
| 5 | Error prevention | 2 | OCR 차단은 개선됐지만 미응답 제출과 문제은행 영구 삭제 예방 흐름이 없다. |
| 6 | Recognition rather than recall | 3 | 원본, 정답, 해설이 함께 보이지만 모바일 검토는 긴 스크롤에 의존한다. |
| 7 | Flexibility and efficiency | 2 | 일괄 확정과 삭제는 좋아졌으나 모든 학습 모드 경로가 검증되지는 않는다. |
| 8 | Aesthetic and minimalist design | 3 | 차분하고 집중도가 높지만 일부 데스크톱 공백과 카드 위계가 약하다. |
| 9 | Error diagnosis and recovery | 3 | 부분 실패 보존과 재시도는 명확하지만 인증, 업로드 오류 상태가 부족하다. |
| 10 | Help and documentation | 2 | 생성 도움은 있으나 AI 검토와 통계 정의의 맥락 도움은 부족하다. |
| **Total** | | **25/40** | **Acceptable — 21점에서 4점 상승** |

## Design Specificity Verdict

생성, 검토, 재학습 흐름은 AMUQ 전용이지만 흰 배경, 회색 카드, 파란 버튼 중심의 시각 언어는 아직 범용 학습 SaaS에 가깝다. 5단계 생성 경로, PDF 원본 병렬 검토, OCR 확인, 부분 재시도, 결과에서 오답 릴레이로 이어지는 순환은 제품 고유성이 분명하다.

## Cognitive Load

3/8 실패로 중간 수준이다. 모바일 문제 검토에서 필터, 일괄 선택, 목록, 원본, 편집기를 긴 한 화면에 쌓아 one thing at a time, minimal choices, progressive disclosure가 실패했다.

## What's Working

- OCR 네 가지 해결 행동과 미해결 진행 차단이 확인됐다.
- 문제 검토에서 원본, 정답, 해설, 출처와 차단 상태가 확인됐다.
- 학습 지표, 기간, 취약 챕터가 대부분 반영됐다.
- 핵심 대비 조합 7개가 모두 WCAG AA를 통과했다.
- 포커스 상태와 부분 실패 복구 흐름이 명확하다.

## Priority Issues

### [P1] Prototype 학습 모드와 실제 연결 불일치

미니 테스트가 모의고사로 연결되고 나머지 네 모드는 작동하지 않는다. 이전 P5/P6 프레임 두 개는 도달 불가이며 로그인 및 체험 분기도 프로토타입에 없다.

### [P1] 고위험 오류 예방 상태 누락

문제은행 이름 재입력 삭제 확인, 미응답 제출 경고와 해당 문제 이동, 로그인 실패, PDF 형식 및 용량 거부, 네트워크 재시도와 주요 loading 및 disabled 상태가 필요하다.

### [P1] 학습 통계 계약 드리프트

Final에 전체 출제 수가 빠졌고 Prototype의 내 학습은 이전 지표와 7일, 30일, 전체 기간을 사용한다.

### [P1] 디자인 토큰 WEB codeSyntax 손상

61개 변수 중 37개에서 `s` 문자가 빠져 구현 인계용 CSS custom property 이름이 잘못됐다. Figma 내부 alias와 대비는 정상이다.

### [P1] 모바일과 폼 의미 구조

모바일 선지 텍스트 폭 470px 고정, Route Step 경계 초과, placeholder를 실제 값처럼 표현한 로그인 필드, 도달 불가 P5/P6의 작은 뒤로 링크가 남아 있다.

## Persona Red Flags

- Jordan: 미니 테스트가 모의고사로 이동하고 확정 전 삭제 상태가 진행 중으로 보여 신뢰를 잃을 수 있다.
- Sam: 일부 링크의 작은 hit area와 모바일 경로 라벨 경계 초과, 전체 인터랙션 포커스 증거 부족이 남아 있다.
- Casey: 모바일 문제 검토가 긴 단일 스크롤이며 최종 CTA와 문맥을 함께 유지하기 어렵다.

## Minor Observations

- 확정 전 삭제 안내를 `삭제 안내` 또는 `확정 후 처리`로 바꿔야 한다.
- 회원가입과 비밀번호 재설정은 링크만 있고 별도 성공 및 오류 상태가 없다.
- 구현 단계에서 긴 AI 문구, 200% 확대, screen-reader tree와 실제 tab order 검증이 필요하다.

## Questions to Consider

- 다섯 학습 모드를 모두 프로토타입으로 검증할지, 대표 경로만 연결하고 해당 카드 이름을 일치시킬지 결정해야 한다.
- 모바일 문제 검토는 목록 선별과 단일 문항 편집의 두 단계로 나누는 편이 더 적합한가?
