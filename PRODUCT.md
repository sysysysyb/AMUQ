# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

- Next.js frontend deployed on Vercel.
- Node.js API and PostgreSQL deployed on Railway.
- The browser uses a same-origin Vercel `/api` proxy to reach the Railway API.
- Private object storage, background-job infrastructure, transactional email, ORM, and migration tooling remain implementation-planning decisions.

## Users

The primary users are individual exam learners who lack enough public practice questions or need to repeatedly study their own material. This includes university students and people preparing for certification or licensing exams.

## Product Purpose

AMUQ turns a learner's PDF material into a private question bank and connects question generation, testing, wrong-answer and bookmark relearning, and progress tracking in one service. Success means learners can see their current performance and improvement without manually organizing study records.

## Positioning

AMUQ combines staged AI assistance with explicit learner review: it proposes document structure and question drafts, but only learner-confirmed questions enter the study loop. Original materials are kept privately only for processing and review, then deleted through a lifecycle that operators can verify and retry.

## Operating Context

- A learner adds one or more PDFs to a private bank one at a time.
- Before generation, AI or the learner assigns every page to a flat chapter or to `생성 제외`.
- The learner reviews exam settings, proposed question counts, generated drafts, and possible duplicates before confirmation.
- Confirmed banks support mini tests, mock exams, and chapter, wrong-answer, and bookmark relays.
- The bank learning home and My Page summarize recent results, current relearning state, trends, and weak chapters.
- Visitors can use an isolated, editable AMUQ demo copy without signing in; it expires after 12 hours and does not provide PDF upload or AI generation.

## Capabilities and Constraints

- User-created banks and learning records are private.
- User-supplied question generation accepts PDF only in the MVP.
- Korean and English text PDFs and printed scan or image PDFs are supported on a best-effort basis.
- Questions are plain-text, single-correct-answer multiple choice with 2–8 options.
- AI output remains a draft until server validation and explicit learner confirmation succeed.
- Confirmed question revisions preserve finalized historical scoring when questions are later edited or removed.
- Original PDFs and content-bearing intermediates are deleted after confirmation; abandoned jobs use a disclosed retention period and retryable cleanup.
- Bank archive and restore, public or shared banks, manual or JSON question import, detailed historical question review, and demo AI generation are outside the MVP.
- The AI model, PDF and generation limits, duplicate-similarity threshold, abandoned-job retention period, and supporting infrastructure providers remain open for implementation planning and feasibility testing.

## Brand Commitments

- Official product name: AMUQ.
- Brand meaning and key message: `아무 자료나 Question으로.`
- Use Mammo green as the fixed global accent. Assign each question bank one of five accessible non-green theme colors; learners do not choose or edit the assignment.
- Keep interface copy concise and remove instructions that do not change a decision or prevent an error.
- Prefer a restrained, serious tone over a childish or overly friendly one, without becoming bureaucratic.
- Mammo Cert Prep is a behavioral and design-quality reference, not the product name or visual identity.

## Evidence on Hand

- `STRATEGY.md` defines the approved product direction, boundaries, metrics, and brand.
- `docs/plans/2026-09-09-0037-feat-amuq-mvp-requirements-plan.md` is the approved requirements-only product contract.
- `docs/planning/question-schema-and-data-model-v1.md` and `docs/contracts/generic-question-package.schema.json` provide approved question and learning-data constraints.
- The Mammo Cert Prep FigJam, wireframes, component system, final screens, and prototype linked from `AGENTS.md` are reference evidence. The FigJam flow named `1. 전체 진입 및 학습 재개 (실패 버전)` is a negative example only.
- No AMUQ application, usability-test result, production metric, testimonial, or customer claim exists yet; future work must not fabricate them.

## Product Principles

- Complete the generation-to-relearning loop; do not ship question generation without a useful way to study the result.
- Make AI assistance reviewable and recoverable instead of silently treating generated output as correct.
- Show current learning progress with less manual record keeping.
- Keep private source material only as long as the generation and review workflow requires.
- Prefer a complete, understandable MVP over speculative management features.

## Accessibility & Inclusion

The responsive web experience must support mobile and desktop layouts, keyboard operation, visible focus, readable contrast, assistive-technology names, and accessible bank accent colors. Critical meaning and state must never depend on color alone.
