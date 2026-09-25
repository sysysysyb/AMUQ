# AGENTS.md

## Core Rules

- Respond in Korean.
- Report assumptions, blockers, scope conflicts, and verification evidence.
- Follow the workflow in order and work on only one GitHub Issue at a time.
- At every stage or Issue approval gate, stop and wait for explicit user approval. Silence and earlier approvals do not authorize later work.
- Follow the global `status.md` and layered Issue-reporting rules.

## Sources of Truth

Apply this priority order:

1. Current GitHub Issue
2. Approved implementation-ready unified plan
3. Approved requirements-only unified plan
4. Approved Figma designs and `docs/DESIGN.md`
5. `docs/STRATEGY.md`
6. `docs/planning/project-handoff.md` for approved discovery decisions not superseded by a source above
7. Relevant `docs/solutions/` — documented solutions to past bugs, best practices, and workflow patterns, organized by category with YAML frontmatter such as `module`, `tags`, and `problem_type`; consult it when implementing or debugging a documented area
8. Existing repository conventions

Stop and report conflicts instead of changing approved artifacts or silently choosing one interpretation.

## Required Capabilities

Before using a skill, plugin, MCP server, or command required by this workflow:

- Verify that the exact capability is installed and configured.
- If unavailable, stop before producing the related artifact or implementation, report what is missing, and ask whether to install or configure it.
- Do not imitate, approximate, replace, or skip it without explicit user approval.
- Verify availability after installation or configuration before resuming.
- Treat temporary directories declared writable by the active environment as in-sandbox locations for skill run artifacts. Use the platform file-write tool or a non-escalated command there; do not request elevated permissions solely because the path is outside the repository. If an in-sandbox write actually fails, report that error before requesting the narrowest necessary escalation.

A similarly named or successor capability is not automatically an approved substitute.

### Railway Tooling

- Load the `use-railway` skill before operating Railway.
- Use Railway CLI for repository-local operations such as linking, deploying local code, `railway run`, SSH, and reproducible CI commands.
- Use Railway MCP primitives for structured project, service, environment, variable, and deployment operations when they are available in the active session.
- Use `railway-agent` only when the user explicitly requests it or direct CLI or MCP inspection cannot resolve a multi-step diagnosis.
- When CLI and MCP are equally suitable, use the more direct operation and do not repeat the same change through both.

## Design References

Use these Mammo Cert Prep artifacts as references for scope, responsive behavior, component quality, state coverage, and level of detail:

- [FigJam — User Flows](https://www.figma.com/board/k6tg0fauLw3zmZbhhgUy7m/mammo-cert-prep-%EC%A0%84%EC%B2%B4-%EC%A7%84%EC%9E%85%EA%B3%BC-%EC%9E%AC%EA%B0%9C-%ED%9D%90%EB%A6%84?node-id=0-1&p=f&t=QgFaHXNYRRoHGCxe-0)
- [Figma — Wireframes](https://www.figma.com/design/AvpcPccWtrcg7tt0he9MSK/mammo-cert-prep-Design?t=QgFaHXNYRRoHGCxe-0)
- [Figma — Design System and Components](https://www.figma.com/design/AvpcPccWtrcg7tt0he9MSK/mammo-cert-prep-Design?node-id=3-2&p=f&t=QgFaHXNYRRoHGCxe-0)
- [Figma — Final Screens](https://www.figma.com/design/AvpcPccWtrcg7tt0he9MSK/mammo-cert-prep-Design?node-id=3-3&p=f&t=QgFaHXNYRRoHGCxe-0)
- [Figma — Prototype](https://www.figma.com/design/AvpcPccWtrcg7tt0he9MSK/mammo-cert-prep-Design?node-id=3-4&p=f&t=QgFaHXNYRRoHGCxe-0)

In FigJam, `1. 전체 진입 및 학습 재개 (실패 버전)` is a negative example only. Analyze why it failed, but never reproduce it or treat it as a source of truth. Use `1. 전체 진입 및 학습 재개` as the valid reference.

## Design Fidelity

Approved Figma screens and `docs/DESIGN.md` are the UI source of truth.

- Implement measured Figma typography, colors, spacing, dimensions, alignment, component states, and responsive behavior without substituting personal preferences.
- Inspect the exact Figma nodes and relevant design properties instead of relying only on screenshots.
- Include the designed loading, empty, error, disabled, focus, hover, and validation states.
- Compare the implementation with Figma at matching viewports and correct visible differences before completion.
- If the design is ambiguous, inconsistent, inaccessible, or technically impractical, report the conflict before deviating from it.

## Validation Policy

- Run all applicable focused tests, relevant suites, type checking, linting, and build commands. Use pnpm unless the repository specifies otherwise.
- Run Playwright E2E for affected critical user flows.
- For UI changes, also run `/ce-test-browser`, `/impeccable audit`, and the required Figma comparison.
- For backend-only changes, run applicable API, integration, authorization, concurrency, and regression tests instead of visual checks.
- After fixes, re-run all affected validation. Report skipped, unavailable, or failed checks explicitly.
- Summarize successful output. Include only relevant excerpts for failures and blockers.

## Backend and AI Guardrails

For Issues involving backend, authentication, private data, file uploads, or AI:

- Derive the current user only from the verified server session. Never trust a client-provided user ID for authorization.
- Scope every private-resource operation to the session user and test cross-user access denial.
- Validate external input on the server and enforce critical invariants with database constraints.
- Use transactions for multi-step state changes and idempotency for submissions, callbacks, retries, and cleanup jobs.
- Store passwords with an approved password-hashing library and protect opaque session cookies according to the approved authentication requirements.
- Compute answers and scores on the server, preserve unanswered states, and bind attempts to the submitted question revision.
- Treat uploaded files, document contents, and AI output as untrusted input. Keep uploads private and enforce approved resource limits.
- AI output may create drafts only. Server validation and explicit user confirmation are required before creating immutable revisions.
- Delete temporary files and AI intermediates according to the approved lifecycle, with retryable cleanup and verifiable completion states.
- Never expose secrets, credentials, session tokens, private document contents, or signed URLs in code, logs, reports, or fixtures.
- Include applicable authorization, failure, concurrency, idempotency, and cleanup tests.

Treat violations of these guardrails as merge blockers.

## Required Project Workflow

### Stage 1: Project Foundation

Run in order:

1. `/ce-setup`
2. Report the setup result and obtain explicit user approval
3. `/ce-strategy`

Use `/ce-setup` to inspect and initialize the environment. Use `/ce-strategy` to create or update `docs/STRATEGY.md` with target users, problem, value, MVP objective, success criteria, and exclusions.

Request approval after `/ce-setup` before running `/ce-strategy`, then report the strategy output and request approval again before Stage 2.

### Stage 2: Requirements

Run `/ce-brainstorm` using the current project context and `docs/STRATEGY.md`. Clarify requirements one question at a time, compare meaningful alternatives, and produce a requirements-only unified plan covering flows, states, edge cases, accessibility, assumptions, and exclusions.

Review the artifact with the user and request approval before Stage 3.

### Stage 3: UX and UI Design

1. Run `/impeccable shape` using the approved requirements, strategy, references, and product conventions.
2. Present the visual direction, hierarchy, UX and responsive principles, and accessibility constraints for approval.
3. After approval, use Figma MCP to create, without intermediate approval gates:
   - FigJam user flow
   - Responsive low-fidelity wireframes
   - Minimum design tokens and system rules
   - Reusable components and variants
   - Responsive final screens and key states
   - Prototype connections for critical flows
4. Run `/impeccable critique`, fix P0/P1 and clear in-scope defects, and perform one bounded re-verification.
5. Present the final artifacts, findings, fixes, and remaining trade-offs for approval.
6. After approval, finalize `docs/DESIGN.md` as the implementation contract.

Figma MCP, not Impeccable, must create or edit FigJam and Figma artifacts. Do not begin Stage 4 without final design approval.

### Stage 4: Implementation Planning

Run in order:

1. `/ce-plan`
2. `/ce-doc-review`

Expand the approved requirements into an implementation-ready unified plan using the approved design, `docs/DESIGN.md`, `docs/STRATEGY.md`, relevant `docs/solutions/`, and the codebase. Include U-IDs, dependencies, execution order, target files, tests, E2E flows, verification commands, completion criteria, and exclusions.

Review without changing approved requirements or designs, then request approval before Stage 5.

### Stage 5: GitHub Issues

1. Split the approved plan into vertical, user-visible delivery units.
2. Map every Issue to U-IDs and include acceptance criteria, dependencies, design references, tests, E2E flows, and exclusions.
3. Present the Issue list and order for approval.
4. Create Issues only after approval.
5. Request approval before starting the first Issue.

### Stage 6: Issue Delivery Loop

Work on one Issue at a time.

#### 6.1 Prepare

- Read the Issue, mapped U-IDs, approved artifacts, and relevant `docs/solutions/`.
- Inspect the working tree and report unrelated or unexpected changes without modifying them.
- Fetch remote changes, update `main` using fast-forward only, and create `<type>/<issue-number>-<imperative-verb>-<short-scope>` with `git switch`.
- Report scope, exclusions, task order, test plan, risks, and verification commands; then request approval.

#### 6.2 Implement

Run `/ce-work` for implementation. Follow this TDD loop for every testable behavior change:

1. Write the smallest relevant test.
2. Run it and observe the intended failure.
3. Write the minimum implementation.
4. Confirm the test passes.
5. Refactor while keeping tests green.

Do not write production behavior before the corresponding test failure. Do not use another implementation orchestrator alongside `/ce-work`.

For non-trivial changes, run `/ce-simplify-code` without changing approved behavior. Apply the Validation Policy.

For UI changes, use `/impeccable polish` only when refinement remains after audit. Never run `/ce-polish` unless the user explicitly requests it for a specific implemented screen.

#### 6.3 Review and Learn

- Run `/ce-code-review` against the Issue, U-IDs, approved plans, and design.
- Fix and re-review P0/P1 findings. Fix P2/P3 only when clear, safe, verified, and in scope; otherwise defer them explicitly.
- Use `/ce-debug` for non-trivial defects or unclear root causes, then apply the Validation Policy again.
- Run `/ce-compound`; store only reusable learning in `docs/solutions/` and allow documentation to be skipped when it would be trivial or duplicated.

#### 6.4 Handoff and Merge

Provide a concise approval report with:

- Completed outcome and U-IDs
- Three to five files or functions to review first, with their responsibilities and important invariants
- Main changes grouped by responsibility
- Red/Green evidence and summarized validation results
- E2E, browser QA, design-fidelity, and UI-audit results when applicable
- Review findings, fixes, deferred findings, and remaining risks
- `/ce-compound` result

Stop and request approval. Do not paste full successful logs or rely on the CLI transcript as the sole durable record.

After approval, run `/ce-commit-push-pr` to push and create or update the PR. Preserve the detailed implementation and verification record in the PR description. Do not merge automatically.

After explicit PR approval, use `Rebase and merge`. Then brief the next Issue and wait for approval before starting it.

### Stage 7: MVP Completion

After all planned MVP Issues are merged:

1. Apply the Validation Policy to the full MVP and all critical flows.
2. Run `/impeccable audit` across the implemented UI and compare it with the approved designs.
3. Fix clear in-scope findings, revalidate, and use `/impeccable polish` only if necessary.
4. Run `/ce-code-review` against the original requirements, design, and implementation plan.
5. Review deferred findings and remaining risks, then produce an MVP completion report.

Request approval before declaring the MVP complete.

### Stage 8: Post-MVP Iteration

Do not begin additional feature development automatically.

When requested:

1. Run `/ce-product-pulse` when usage, performance, or error data exists; otherwise summarize feedback, deferred findings, and exclusions.
2. Run `/ce-ideate`, compare candidates, and let the user select the next scope.
3. Run `/ce-brainstorm` for the selected feature and repeat from Stage 2.

Run `/ce-strategy` again only when the product direction, target user, core value, or MVP strategy changes.

## Git Rules

- Use `git switch`, not `git checkout`.
- Commit cohesive completed units using an existing Gitmoji and a capitalized Conventional Commit type.
- Name non-Issue branches `<type>/<imperative-verb>-<short-scope>` and describe the work itself instead of a workflow stage or stage number.
- For Issue branches, use `<type>/<issue-number>-<imperative-verb>-<short-scope>`.
- Do not push, create a PR, or merge without explicit user approval.
- This is a solo project. Do not run `ce-babysit-pr` or otherwise monitor a Pull Request unless the user explicitly requests monitoring in the current turn. After creating or updating a Pull Request, report it immediately and wait for user review.
- Use `Rebase and merge` by default. Do not choose another merge strategy without explicit approval.
