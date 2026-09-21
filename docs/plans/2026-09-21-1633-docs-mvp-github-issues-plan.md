---
title: AMUQ MVP GitHub Issues - Plan
type: docs
date: 2026-09-21
origin: docs/plans/2026-09-09-0037-feat-amuq-mvp-requirements-plan.md
execution: knowledge-work
---

# AMUQ MVP GitHub Issues - Plan

## Goal

승인된 구현 계획을 범위 중복 없이 실행 가능한 GitHub Issue 목록으로 옮긴다. 각 U-ID를 하나의 Issue로 유지하고 U01부터 U13까지 순서대로 한 건씩 구현한다.

## Splitting Rules

- U01부터 U13까지 각각 하나의 Issue로 만든다. 현재 단위는 결과, 책임, 검증 경계가 구분되어 있어 추가 분할이나 병합이 필요하지 않다.
- 각 Issue는 구현 계획의 해당 U-ID를 기준으로 작성하고 요구사항이나 테스트 계약 전체를 복사하지 않는다.
- 선행 Issue가 병합되기 전에는 다음 Issue를 시작하지 않는다.
- UI가 있는 Issue는 `docs/DESIGN.md`의 해당 흐름과 승인된 Figma Final Screens 및 Prototypes를 함께 연결한다.
- U01에서 Fastify route schema로 OpenAPI 문서를 생성하고 개발 환경에서 Swagger UI를 여는 공통 기반을 만든다. production에서는 Swagger UI를 노출하지 않는다. 이후 API를 추가하는 Issue는 같은 route schema에 요청, 응답, 오류 계약을 함께 기록한다.
- 모든 Issue는 계획의 공통 Definition of Done과 Implementation Exclusions를 상속한다.

## Proposed Issues

| Order | Proposed title | Traceability | Depends on | Reviewable outcome | Required evidence | Design reference | Labels |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Establish the deployable application foundation | U01, R43-R45 | None | Web, API, worker, PostgreSQL과 같은 출처 `/api` 경계를 실행하고 OpenAPI 기반 Swagger 문서를 제공한다. | Boot, migration lock, proxy, DB pool, shutdown, preview health, OpenAPI 생성과 문서 접근 정책 검증 | UI 없음 | `backend` |
| 2 | Add secure authentication and account access | U02, R1-R3, R43-R45 | U01 | 이메일과 Google 인증, 재설정, 서버 세션과 최소 트랜잭션 이메일을 제공한다. | 인증 및 보안 integration test와 desktop 및 mobile 인증 E2E | `docs/DESIGN.md` 7.1 | `feature`, `backend`, `frontend` |
| 3 | Add private problem banks and question revisions | U03, R3, R5-R9, R27-R29 | U02 | 사용자별 문제은행 목록, 상세, 테마, 영구 삭제와 immutable question revision 기반을 제공한다. | DB 제약, cross-user denial, 삭제와 revision 규칙 및 문제은행 E2E | `docs/DESIGN.md` 5-8 | `feature`, `backend`, `frontend` |
| 4 | Select the PDF generation provider and operating limits | U04, R10-R19, R22 | U01, approved Question Package contract | 생성 공급자와 모델 하나, 중복 탐지 기준, PDF 처리 및 사용자 생성 한도를 수치로 확정한다. | 한국어 및 영어 text와 scan 품질, 개인정보, 비용, 정확한 50,000,000-byte 경계와 중복 benchmark | UI 없음 | `ai`, `backend` |
| 5 | Add private PDF analysis and document classification | U05, R10-R17, R20, R25-R26, AE1-AE2 | U03, U04 | 안전한 PDF 업로드, 복원 가능한 분석 상태와 완전한 페이지 분류를 제공한다. | 업로드 및 worker contract, 소유권, 한도, 재시도, page partition test와 분석 E2E | `docs/DESIGN.md` 7.2의 Exam Info부터 Editable Criteria | `feature`, `ai`, `backend`, `frontend` |
| 6 | Generate, review, and finalize AI questions | U06, R18-R26, F1-F2, AE3-AE5 | U05 | 부분 실패를 복구하고 초안을 검토한 뒤 한 번에 확정하며 원본 삭제를 검증한다. | 예시 문제 비복제, AI 검증, 재시도, 중복 후보, 확정 idempotency, cleanup과 생성 E2E | `docs/DESIGN.md` 7.2의 AI Generation부터 Bank Home | `feature`, `ai`, `backend`, `frontend` |
| 7 | Edit and remove finalized questions safely | U07, R27-R29, R42, F5, AE9 | U06 | 확정 문제를 수정하거나 이후 출제에서 제거하면서 과거 점수와 revision을 보존한다. | 동시 revision, 출제 제외, 과거 결과 불변, cross-user denial과 편집 E2E | Final Screens의 문제 목록 및 결과 편집 흐름 | `feature`, `backend`, `frontend` |
| 8 | Add resumable mini tests | U08, R30, R33-R34, R37, F3, AE7 | U07 | 중복 없는 미니 테스트를 시작하고 답안을 저장 및 재개한 뒤 한 번만 제출한다. | 선택, 답안 version, 미응답, 동시 제출, 정답 비노출과 반응형 E2E | `docs/DESIGN.md` 7.3 | `feature`, `backend`, `frontend` |
| 9 | Add timed mock exams and automatic submission | U09, R31-R34, F3, AE6-AE7 | U08 | 서버 시간 기준 모의고사와 문제 부족 시 조정 시간 및 자동 제출을 제공한다. | 시간 비례 계산, clock skew, 수동 및 자동 제출 경합, 만료 경계와 모의고사 E2E | `docs/DESIGN.md` 7.4 | `feature`, `backend`, `frontend` |
| 10 | Add chapter, wrong-answer, and bookmark relays | U10, R35-R37, F4, AE8 | U08, implemented after U09 | 세 릴레이가 시작 대상을 고정하고 한 문제씩 즉시 피드백과 세션 요약을 제공한다. | 대상 snapshot, 중복 방지, 오답 해제, 북마크 독립성과 세 릴레이 E2E | `docs/DESIGN.md` 7.5 | `feature`, `backend`, `frontend` |
| 11 | Add the learning dashboard and progress statistics | U11, R38-R42 | U09, U10 | 현재 문제은행의 최근 학습과 기간별 통계를 같은 데이터 원본에서 제공한다. | 기간 경계, 분모 0, bank 격리, 정렬, 차트 접근성과 통계 E2E | `docs/DESIGN.md` 7.6 | `feature`, `backend`, `frontend` |
| 12 | Add the isolated demo and verified data deletion | U12, R2, R4, R8, R26, R45, F6, AE10 | U03, U06, U08-U11 | 6시간 격리 데모와 계정 및 파일 데이터의 접근 차단, 삭제와 재처리를 제공한다. | 데모 격리 및 만료, 삭제 경합, 외부 정리 재시도, cross-user denial과 두 브라우저 E2E | Final Screens와 Prototypes의 데모 및 계정 관리 흐름 | `feature`, `backend`, `frontend` |
| 13 | Add privacy-safe observability and release validation | U13, R43-R45, Success Criteria | U01-U12 | Sentry와 PostHog로 오류와 핵심 흐름을 개인정보 없이 관측하고 전체 MVP를 출시 기준으로 재검증한다. | 이벤트 allowlist, scrubber, provider 장애 비간섭, 전체 critical E2E, Figma 비교와 lifecycle drill | `docs/DESIGN.md` 전체 검증 계약과 승인된 Figma | `backend`, `frontend` |

## Issue Body Contract

각 Issue는 다음 항목만 구체화한다.

- `Requirement IDs`: U-ID와 연결된 R, F, AE-ID
- `User-visible outcome`: 완료 후 사용자가 얻는 결과 한 문장
- `Acceptance criteria`: 해당 U-ID의 Completion과 핵심 불변식
- `Dependencies`: 선행 U-ID와 생성 후의 GitHub Issue 링크
- `Design references`: 관련 `docs/DESIGN.md` 절과 정확한 Figma node
- `Tests and E2E flows`: 그 Issue가 직접 증명할 red/green, integration, E2E 범위
- `Exclusions`: 공통 Implementation Exclusions와 단위별 인접 범위

본문은 구현 계획의 해당 U-ID와 공통 Verification Contract를 링크하고 반복해서 복사하지 않는다.

## Label Plan

현재의 pastel-tone `feature`, `backend`, `frontend`, `ai`, `docs`, `bug` 라벨만 사용한다. 새 라벨은 만들지 않는다.

`.github/ISSUE_TEMPLATE/feature.yml`과 `bug.yml`은 실제 `feature`, `bug` 라벨을 기본값으로 사용한다.

## Approval Gate

이 목록과 순서가 승인된 뒤에만 GitHub Issue를 생성한다. 생성할 때 실제 Issue 번호로 의존성을 연결하고, 모두 생성한 뒤 첫 번째 Issue의 준비 작업을 시작하기 전에 다시 승인을 받는다.
