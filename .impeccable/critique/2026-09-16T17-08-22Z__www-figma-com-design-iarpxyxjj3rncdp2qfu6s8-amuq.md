---
target: "Figma Final Screens ??Revised (node 1032:9888)"
total_score: 31
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
target_identity: "url:https://www.figma.com/design/iArpXyXjJ3rNCDP2QfU6s8/AMUQ"
timestamp: 2026-09-16T17-08-22Z
slug: www-figma-com-design-iarpxyxjj3rncdp2qfu6s8-amuq
---
#### Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 4 | OCR 미확인 수, 처리 조건, 생성/검토 상태가 명확함 |
| 2 | Match System / Real World | 3 | PDF·페이지·문제은행 언어는 자연스럽지만 일부 계정 문구가 반복됨 |
| 3 | User Control and Freedom | 3 | 중복 검토를 선택 사항으로 완화했고 되돌아가기 경로가 있음 |
| 4 | Consistency and Standards | 3 | 로컬 Text Style과 상태 컴포넌트 사용이 대체로 일관적임 |
| 5 | Error Prevention | 4 | OCR 4페이지 처리 전 CTA 비활성화가 명시적으로 보임 |
| 6 | Recognition Rather Than Recall | 3 | 단계·상태·선택지가 화면에 드러나지만 긴 검토 화면은 스캔 부담이 있음 |
| 7 | Flexibility and Efficiency | 2 | 대량 검토의 요약·빠른 이동 수단은 아직 제한적임 |
| 8 | Aesthetic and Minimalist Design | 3 | 절제된 구조지만 일부 화면에 과도한 수직 공백과 밀도가 공존함 |
| 9 | Error Recovery | 4 | 삭제 재시도와 파일 정리 상태가 명확하게 추가됨 |
| 10 | Help and Documentation | 2 | 첫 사용자를 위한 맥락 도움은 최소 수준임 |
| **Total** | | **31/40** | **Good — prototype threshold passed** |

#### Design Specificity Verdict

**LLM assessment:** AMUQ의 PDF→OCR→분류→문제 생성→학습 흐름이 구조에 강하게 반영되어 제품 고유성은 중상 수준이다. 조용한 종이 질감과 Mammo 계열 녹색도 일관된다. 다만 카드·폼·리스트의 시각 언어는 여전히 범용 SaaS 패턴에 가깝다.

**Deterministic scan:** Figma URL 대상이라 CLI detector는 정상적으로 생략했다. 공식 Figma 구조·속성·렌더 검사에서 원본 `Final Screens`와 수정본 `Final Screens — Revised`가 별도로 존재하고, 수정본의 비-Pretendard 텍스트는 의도된 Google 로그인 Roboto 6개뿐임을 확인했다. 독립 검증이 잡은 랜딩 미리보기의 두 번째 문항과 모바일 피드백 폭 초과는 수정 후 재검증했다.

**Visual overlays:** 새 브라우저 세션에서 Figma가 CloudFront 403을 반환해 신뢰할 수 있는 DOM 오버레이는 만들지 못했다. 대신 공식 Figma 렌더와 노드 경계 검사를 사용했다.

#### Overall Impression

핵심 상태 모델과 오류 예방은 출시 전 디자인으로 충분히 단단해졌다. 가장 큰 남은 기회는 검토해야 할 양을 사용자가 한눈에 파악하고 빠르게 끝낼 수 있도록 요약·이동성을 높이는 것이다.

#### What's Working

- OCR 미확인 4페이지와 비활성 CTA가 같은 화면에서 원인과 다음 조건을 함께 설명한다.
- 중복 검토를 선택 사항으로 바꾸고 확정 CTA를 활성화해 불필요한 강제 흐름을 제거했다.
- 원본·임시 파일 삭제, 실패 시 자동 재시도, 삭제 완료 상태가 생성 종료 흐름에 연결돼 데이터 수명주기가 보인다.
- 미니 테스트는 랜딩 미리보기와 실제 테스트 모두 화면당 한 문항으로 정리됐다.

#### Priority Issues

1. **[P2] 대량 검토의 진행 요약이 약함**
   - **Why it matters:** 데스크톱 9개 렌더 창에서 남은 수량·검토 완료량을 빠르게 파악하기 어렵다.
   - **Fix:** `검토 완료 / 남음 / 제외` 요약과 현재 위치를 상단 또는 sticky action 영역에 추가한다.
   - **Suggested command:** `$impeccable clarify`

2. **[P2] 회원가입 비밀번호 필드 라벨 중복**
   - **Why it matters:** 비밀번호와 확인 입력을 구분하기 어렵다.
   - **Fix:** 두 번째 라벨을 `비밀번호 확인`으로 바꾸고 불일치 오류 상태를 연결한다.
   - **Suggested command:** `$impeccable harden`

3. **[P2] 일부 모바일 보조 텍스트와 아이콘 액션이 작음**
   - **Why it matters:** 터치와 이해 부담이 커진다.
   - **Fix:** 본문 최소 크기와 44px 터치 영역, 접근 가능한 이름/툴팁을 보장한다.
   - **Suggested command:** `$impeccable adapt`

4. **[P3] 최종 확정 화면의 수직 공백이 큼**
   - **Why it matters:** 삭제 안내와 최종 결정 동작의 결속이 약해진다.
   - **Fix:** 삭제 안내와 CTA를 더 가깝게 묶는다.
   - **Suggested command:** `$impeccable layout`

#### Persona Red Flags

- **처음 사용하는 수험생:** 전체 문제 검토에서 얼마나 남았는지 먼저 찾게 된다.
- **모바일 중심 사용자:** 작은 보조 텍스트와 아이콘 전용 액션은 터치·이해 부담이 남는다.
- **반복 학습 파워 유저:** 대량 검토의 빠른 필터·완료 요약·키보드 효율이 부족하다.

#### Minor Observations

- 전역 홈에 동일한 문제은행 샘플이 반복돼 실제 다양성이 덜 느껴진다.
- 오류 상태에 입력 내용 보존 여부를 명시하면 복구 신뢰도가 더 올라간다.
- 랜딩의 작은 보조 문구는 실제 모바일 구현 시 최소 글자 크기를 다시 확인해야 한다.

#### Questions to Consider

- 대량 검토에서 가장 중요한 빠른 작업은 `남은 항목 이동`, `문제 제외`, `중복 판단` 중 무엇인가?
- 모바일 아이콘 액션은 항상 텍스트 라벨을 붙일지, 접근 가능한 툴팁과 44px 영역으로 유지할지 결정이 필요하다.
