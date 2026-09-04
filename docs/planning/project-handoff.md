# Project Handoff — Generic Private Question Bank Platform

> **Status:** ChatGPT discovery decisions approved by the user on 2026-09-03
> **Purpose:** Input for `/ce-setup`, `/ce-strategy`, and `/ce-brainstorm`; not an implementation-ready plan

## 1. Usage

* Read `AGENTS.md` first and follow its workflow and approval gates.
* Preserve the approved decisions below unless repository evidence or a material trade-off requires reconsideration.
* Report conflicts instead of silently changing this handoff or an approved artifact.
* Do not implement directly from this document. Convert it into approved CE strategy, requirements, design, and implementation artifacts in order.

## 2. Product and MVP

Upgrade Mammo Cert Prep from a static, browser-local exam app into a general-purpose private question-bank and study platform.

* **Primary user:** Individual exam learner
* **Core problem:** Question solving and wrong-answer relearning are difficult to continue in one place.
* **First value:** Create a private bank from personal material and study it.
* **Primary loop:** Mini test → result → wrong-answer relearning
* **Scope:** User banks remain private; Mammo becomes a read-only system demo bank.
* **Portfolio goal:** A frontend-strong, production-like full-stack vertical slice demonstrating product reasoning, faithful UI, data integrity, authentication, AI workflow, testing, deployment, and operations.
* **Brand:** Replace the Mammo-specific name. Prefer an English brand with a clear Korean descriptor and finalize it before `/impeccable shape`.

### MVP Includes

* Email/password and Google authentication, email verification, password reset, and account deletion
* Private bank creation, editing, revision, archive, restore, and permanent deletion
* Manual entry, JSON import, Mammo seed migration, and AI PDF import
* Mini test, configurable mock exam, section relay, wrong-answer relay, and bookmark relay
* Results, bookmarks, history, and a chart-based learning dashboard
* Responsive and accessible UI matching approved Figma designs
* Isolated temporary demo accounts with a strictly limited real AI PDF experience
* Vercel/Railway deployment, automated tests, browser QA, and basic operational logging

### Completion Criteria

1. The core vertical slice works end to end: signup/login → private bank → PDF upload → AI draft → review/confirm → mini test → result → wrong-answer relay → dashboard.
2. The release candidate passes automated, browser, design-fidelity, security, and code review.
3. The user then runs a 1–3 person usability test and resolves critical feedback before declaring the MVP complete.

### MVP Exclusions

* Public/shared user banks, social features, collaboration, rankings, recommendations, adaptive learning, or admin UI
* Multiple-answer, true/false-specific, short-answer, essay, image, math, or rich-text questions
* Custom OCR, advanced RAG/vector search, AWS migration, Kubernetes, microservices, and decorative over-engineering

## 3. Question and Learning Model

### Question Contract

* MVP supports plain-text, single-correct-answer multiple choice with 2–8 options.
* Required: section, prompt, options, one correct option, and overall explanation.
* Optional: topic, difficulty, tags, key concept, per-option rationale, and source locator.
* Ownership, workflow, and AI-validation state are server-managed and never trusted from import input.
* Validate imports with JSON Schema and then server-side semantic validation. Schema-valid AI output is not necessarily correct.

```text
QuestionBank
└─ BankSection
   └─ Question (stable identity)
      ├─ QuestionDraft (editable; not studyable)
      └─ QuestionRevision (immutable)
         └─ QuestionOption

StudySession
└─ QuestionAttempt → exact QuestionRevision

Bookmark → stable Question
```

* Confirming a draft creates an immutable revision.
* A study session pins its bank release; each attempt pins the submitted revision.
* Never retroactively regrade historical attempts after a question changes.
* “Current wrong” means the latest submitted attempt for a Question is incorrect or unanswered.
* Preserve `unanswered` as a distinct result but score it as incorrect. Accuracy denominator is correct + incorrect + unanswered.

### Versioning and Contracts

* Question revisions use increasing integers.
* Bank releases use SemVer: PATCH for non-semantic corrections; MINOR for question/answer/membership changes; MAJOR for incompatible type, scoring, or scope changes.
* Reject an obviously invalid PATCH even when the system suggests version categories.
* Keep separate contracts for:
  1. `generic-question-package.schema.json` — JSON, Mammo migration, and AI interchange
  2. PostgreSQL — ownership, workflow, revisions, attempts, and history
  3. API author/test/review DTOs — test DTOs must not expose answers or explanations

## 4. Authentication and Account Lifecycle

* Use one `User` with email/password and Google identities, unified through server-side DB sessions.
* Signup: email, password, confirmation → pending-verification screen → email link → login. Do not issue an authenticated app session before verification.
* Generate the initial non-unique nickname once from the email local part, limited to six user-visible characters.
* Verification token: hashed, one-time, 24 hours. Reset token: hashed, one-time, 30 minutes; successful reset returns to login.
* Hash passwords with an approved Argon2id library; never implement custom cryptography.
* Google uses `openid email profile` and the stable `sub`, not email, as its identity.
* Never auto-link on matching email. Create a 10-minute link request, require the existing password and explicit consent, then link and issue the session transactionally.
* Session: 256-bit opaque token; raw value only in the cookie, SHA-256 hash in PostgreSQL.
* Cookie: `__Host-session`; `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`.
* Expiry: 7-day idle and 30-day absolute. Support multiple devices; rotate after auth-state changes.
* Logout revokes the current session. Password reset, deletion, or suspension revokes all sessions.
* Protect state-changing requests with approved Origin/CSRF checks.
* Expiry returns a stable 401, clears the cookie, and redirects to `/login?reason=session-expired&returnTo=...` with a safe relative return path. Preserve safe in-progress answers but never replay state-changing requests automatically.
* Account statuses: `PENDING_VERIFICATION`, `ACTIVE`, `PENDING_DELETION`, `SUSPENDED`.
* Remove abandoned unverified accounts after 7 days.
* Deletion requires recent reauthentication, immediately revokes sessions, and provides a 14-day cancellation period. Final cleanup must be transactional, race-safe, retryable, and complete.

## 5. Banks, Study, and Dashboard

* Derive bank ownership from the verified session. Never trust a client-provided user ID.
* Mammo is system-owned and read-only; user banks are private.
* Manual, JSON, and AI questions always enter `QuestionDraft` first.
* Provide explicit **Save draft** and **Save and include** actions; no MVP autosave.
* Archive used Questions instead of hard-deleting them. Unused drafts may be deleted.
* Banks support archive/restore; permanent deletion requires explicit title confirmation.
* JSON import: validate → drafts → user review → confirmed revisions.
* Persist selected answers with optimistic UI and a short debounce; flush before navigation/submission and prevent stale overwrites.
* Final submission is idempotent, and the server computes correctness and score from pinned revisions.
* When answers are missing, list their numbers and offer “Move to first unanswered” or “Submit including unanswered.”
* Dashboard periods: 1 month, 6 months, 1 year (default), 3 years, all.
* Dashboard covers attempts, accuracy, current wrong, unanswered, bookmarks, retry accuracy, mock results, trends, and weak sections.
* Select a chart library after repository inspection; exclude Three.js from MVP analytics.

## 6. AI PDF and Demo

### AI PDF

* Use the OpenAI Responses API with a suitable vision-capable model chosen after feasibility testing.
* Support Korean/English text PDFs and printed scan PDFs as best-effort beta input.
* Present one-PDF upload UX and process internally by page ranges/chunks.
* Treat roughly 100-page study material as a usability benchmark, not a committed limit. Test 20/50/100-page text and scan samples before fixing quotas.
* Store uploads in private object storage using server-generated paths and limited access, not in PostgreSQL.
* Pipeline: upload → private storage → job → analysis → structured output → schema/semantic validation → drafts → human review → confirm/discard.
* AI output may never create a studyable revision directly.
* Complete the job only after every draft is confirmed or discarded, then purge PDFs, temporary/page files, extracted content, raw content-bearing responses, provider files, retry payloads, and DB pointers.
* Cleanup requires verifiable states, retries, and expiry for abandoned jobs.
* Use `store: false`, provider file expiry/deletion, and redacted logs where supported. Do not claim that these remove every provider-retention or copyright risk.
* Require a private-use/rights affirmation and keep imported material private.

### Demo

* Create an isolated temporary account/session per visitor; never use shared reusable credentials.
* Permit a strictly capped real AI flow using self-authored or openly licensed sample material.
* Automatically delete the demo account and all related files, jobs, drafts, and history after a short TTL. Current direction is no longer than one day; finalize after testing.
* Explain the temporary-data policy in the UI.

## 7. Existing Mammo and Architecture

| Treatment | Scope |
| --- | --- |
| Reuse directly | Tokens, icons, focus/a11y patterns, Button, Dialog, Explanation, Progress, BookmarkButton presentation, PageLoading, ExamTimer, shuffle utilities |
| Restructure and reuse | Question/Review cards, Header/Home, study modes, wrong/bookmark flows, summaries, MyPage, Ajv validation, migration scripts, tests |
| Build new | API, PostgreSQL, auth/authorization, bank CRUD, drafts/revisions, AI jobs/files, dashboard data, deployment/operations |
| Remove/replace | localStorage persistence, three-way reconciliation, fingerprints, static loaders/export assumptions, guest import, fixed chapters/counts/options, client scoring, monolithic provider |

Separate server data, authentication, active study session, local UI, and import-job responsibilities.

```text
Vercel: Next.js frontend + same-origin /api proxy
Railway: Node API + PostgreSQL
Private object storage: provider selected after setup
```

The browser calls Vercel `/api`, which proxies Railway. Separate development, test, and production data/secrets. AWS is post-MVP only.

## 8. Quality, Delivery, and Approval

* Follow `AGENTS.md` for TDD, validation, Figma fidelity, browser QA, review, reporting, and Git approval rules.
* Authorization, server scoring, DB constraints, transactions, idempotency, cleanup, and secret redaction are merge blockers.
* Keep CLI reports concise, `status.md` current, and durable evidence in PR descriptions.
* Before PR creation for auth, schema/migration, authorization, scoring/revision, AI/files, deletion, and deployment security, provide a code walkthrough.
* For selected high-value Issues, the user may complete one 15–30 minute test or small change without a separate learning record or commit.
* Preserve only major reusable decisions and measured evidence; do not invent metrics.

### Delivery Direction

* **Walking skeleton:** Email login → manual private bank/revision → mini test → result → wrong-answer relay
* **Week 1:** Setup, strategy, requirements, design, plan, and early AI feasibility spike
* **Week 2:** API/DB, email auth/session, authorization, manual banks/revisions, Mammo migration
* **Week 3:** Core study flows and AI import/review/purge
* **Week 4:** Mock exam, dashboard, Google linking, account/demo lifecycle, deployment, and final QA

The final Issue breakdown belongs to `/ce-plan`. Run the AI spike early. If the schedule slips, revise it explicitly while preserving Issue order, security, tests, and review.

Obtain explicit approval for strategy, requirements, design direction, final design, implementation plan, proposed Issues, each Issue before/after implementation and merge, the release candidate, and final MVP completion.

## 9. References, Legacy Status, and Deferred Decisions

### Figma References

* [FigJam — User Flows](https://www.figma.com/board/k6tg0fauLw3zmZbhhgUy7m/mammo-cert-prep-%EC%A0%84%EC%B2%B4-%EC%A7%84%EC%9E%85%EA%B3%BC-%EC%9E%AC%EA%B0%9C-%ED%9D%90%EB%A6%84?node-id=0-1&p=f&t=QgFaHXNYRRoHGCxe-0)
* [Figma — Wireframes](https://www.figma.com/design/AvpcPccWtrcg7tt0he9MSK/mammo-cert-prep-Design?t=QgFaHXNYRRoHGCxe-0)
* [Figma — Design System and Components](https://www.figma.com/design/AvpcPccWtrcg7tt0he9MSK/mammo-cert-prep-Design?node-id=3-2&p=f&t=QgFaHXNYRRoHGCxe-0)
* [Figma — Final Screens](https://www.figma.com/design/AvpcPccWtrcg7tt0he9MSK/mammo-cert-prep-Design?node-id=3-3&p=f&t=QgFaHXNYRRoHGCxe-0)
* [Figma — Prototype](https://www.figma.com/design/AvpcPccWtrcg7tt0he9MSK/mammo-cert-prep-Design?node-id=3-4&p=f&t=QgFaHXNYRRoHGCxe-0)

FigJam `1. 전체 진입 및 학습 재개 (실패 버전)` is a negative example only. Use `1. 전체 진입 및 학습 재개` as the valid reference.

### Supporting Artifacts

* `docs/planning/question-schema-and-data-model-v1.md`
* `docs/contracts/generic-question-package.schema.json`
* `docs/private/recruiting-portfolio-benchmark.md` (local-only; excluded from Git)
* Project `AGENTS.md`

The Question Schema body and approval metadata reflect the approved direction recorded in this handoff.

Existing Mammo `STRATEGY.md`, `DESIGN.md`, localStorage, and static-export assumptions are legacy baseline material. Newly approved artifacts supersede conflicts.

### Decide After Repository Inspection

* Repository/package structure, API framework, ORM, and migration tooling
* Object storage, background job/queue, and transactional email providers
* Chart library, OpenAI model, PDF/AI quotas, and demo TTL
* Custom domain and production observability details

These decisions are not blockers for `/ce-setup`.

## 10. Continuation Rule

* The repository has been created and connected to GitHub by the user.
* Use `status.md` for the current next action instead of treating this handoff as a live status file.
* In Stage 1, run `/ce-setup`, report its result, and wait for explicit user approval before `/ce-strategy`.
