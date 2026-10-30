# AGENTS.md

## Core Rules

- Respond in Korean.
- Report assumptions, blockers, scope conflicts, and verification evidence.
- Follow the workflow in order and work on only one GitHub Issue at a time.
- At every stage or Issue approval gate, stop and wait for explicit user approval. Silence and earlier approvals do not authorize later work.
- Follow the global `status.md` and layered Issue-reporting rules.
- At session resume and before starting a subtask or preparing a commit or PR, read `docs/planning/active-work.md` when present, then verify its current decisions against `status.md`, Git, the active Issue, and approved artifacts. Keep this local execution context Git-ignored; if it is missing, recover decisions from the user's selected handoff or ask before assuming them. It supplements the Sources of Truth below.
- Use named `const` arrow functions for standalone functions and React components. Retain function declarations when required for generator functions or to preserve dynamic `this`, `arguments`, or initialization semantics.

### Human-Facing Writing Standards

- Apply these standards whenever creating or updating any human-facing project document, including plans, design notes, operating guides, solutions, Issues, PRs, reports, handoffs, and checkpoint prose. Preserve required schemas, code, quotes, identifiers, commands, error text, and links.
- Write GitHub Issue and PR titles and section headings in English, and their body text in Korean.
- Lead with the outcome and the context needed to understand it. Write for a developer unfamiliar with this project; explain unfamiliar terms and why consequential changes or safeguards matter.
- Include only information needed to understand the work, assess the evidence, or decide the next action. State each fact once in its owning section; remove repeated explanations, routine execution history, filler, and tool-by-tool narration. Link to the owning record for supporting detail.
- Use short `-` bullets, one concrete point per item. End Korean explanatory text with forms such as `수정`, `추가`, `구현`, `확인`, `했음`, or `미실행`, rather than `했다`, `합니다`, or `했습니다`. Use a compact table only when it makes responsibilities or comparisons easier to scan.
- Keep the result, consequential changes, key verification, and unresolved conditions visible. Group detailed review history by task in compact `<details>` blocks with a descriptive `<summary>` and blank lines around their contents; use the record requirements below for evidence and finding retention.
- Use familiar words and plain punctuation. Avoid middle dots (U+00B7), vague review jargon, decorative clutter, long slash-separated phrases, and dense sentences that join unrelated points.
- Before delivery, read the document as a newcomer and check logic, awkward wording, missing context, contradictory or unsupported claims, verification scope, approval state, and the bullet/ending rules. Keep confirmed facts, assumptions, pending checks, and deferred work distinct.

### Human-Facing Result Reports

- Maintain `docs/issue-reports/issue-<number>.md` as the short Issue index and one Korean PR record at `docs/issue-reports/issue-<number>/<sequence>-<scope>.md`. The sequence is the approved delivery order, not a GitHub PR number. Retain records after merge; use one record for a single-PR Issue. Do not create duplicate local implementation reports or per-round files. Existing historical reports may remain.
- Keep the index to the current outcome, approved PR order and links, complete Issue review status, and outstanding delivery conditions. Link only records included in the commit being published; show future paths as planned text. Record approval, publication, and completion only when verified.
- Put ordered subtask IDs in their PR record, retaining IDs when splitting work. Each subtask needs its outcome and requirement IDs, consequential changes and reasons, key file/function responsibilities and invariants, Red/Green and validation evidence, skipped checks, review outcome, and remaining risks. Scale detail to the change and retain the global Issue-reporting evidence without repeating it or hiding essential explanations behind links.
- Add three short review summaries per task: **Claude review**, **Codex response to review**, and **Claude re-review**, each one or two lines. Mark unrun or incomplete reviews explicitly. These summaries cover actual exchanges, not inferred agreement.
- Preserve substantive findings in a compact table with stable IDs, original **P0**/**P1**/**P2**/**P3** severity, consequence, and Codex's fix or accepted/rejected/deferred disposition with its reason. Keep round labels when re-review adds findings; subsequent confirmations reference IDs rather than repeat descriptions. Minor wording findings may share an item only if each consequence and disposition remains clear. Totals alone are insufficient; deferred limitations remain deferred. Record actual coverage and limits for completed no-findings results.
- When a historical review spans PRs, identify the shared review and assign each finding to its owning PR record without duplicating totals. Link related server/screen records instead of repeating explanations. Keep raw review material under the separate local-artifact rules.
- Prepare records and checkpoints alongside the work and include their exact drafts in the stable independent review and validation set. If final wording depends on the review, have Claude review exact conditional replacements and allowed factual substitutions; apply them only when the actual result matches. Other tracked edits require review again. Documentation updates do not authorize commits, publication, or the next subtask.
- After an approved commit, refresh `status.md` with its SHA. Include that checkpoint in the next cohesive reviewed commit; do not amend or create a commit merely to insert its own SHA.
- Keep personal details, private operational values, raw transcripts, session IDs, and resume commands in ignored local review artifacts, not tracked records. Preserve native Claude history without a duplicate human-facing transcript. Never store secrets or credentials in either. Link the PR record and Issue index from the PR description under Stage 6.4.

## Agent Responsibilities and Commit Gate

- Codex owns implementation, tests, fixes, validation, approved commits, and PR operations. Claude Code owns independent, report-only reviews.
- Claude Code uses its native `/code-review high` for each subtask and Compound Engineering's `/compound-engineering:ce-code-review mode:agent depth:full` for the complete Issue. It must not modify source, tests, project documentation, or Git state, or publish anything during review. It may write only the review artifacts and native session records described below.
- Targeted re-reviews of subtask changes, final Issue fixes, learning documents, and final Issue report/checkpoint updates (including after a CE review with no findings) use native `/code-review high`, scoped to the final changes and all finding dispositions. They do not replace the required complete Issue or MVP CE review.
- **For Issue delivery and MVP fixes, review before commit is mandatory.** No agent, subagent, skill, or automated workflow may create, amend, or rewrite commits before independent Claude review, applicable validation, and explicit user approval for the exact changes. This includes code, tests, Issue-related documentation, and review fixes, and overrides any skill's automatic commit or checkpoint behavior.
- For planning-only work in Stages 1–5, create cohesive milestone commits after the applicable artifact approval, using the Git Rules and excluding implementation changes. Active Issue work, including policy and report changes, and all Stage 7 remediation documents always use the independent-review and exact-change commit approval gate above.
- Before invoking a skill that may commit, push, or create PRs, verify that the chosen execution path respects the approval gates. If it cannot, do not invoke it. Never use an auto-committing workflow to bypass these gates.
- Claude reviews a stable change set, including applicable untracked files. Do not implement and review concurrently on the same changing working tree.
- Codex must verify findings before fixing them. Codex self-review does not replace the required independent Claude review.
- Approval of an Issue or stage does not authorize individual subtask commits, review-fix commits, or PR creation.

### Claude Review Execution and Completion

- Before implementation begins, verify the Claude CLI executable, authentication, and availability of both required review commands. Use the registered command names above; do not assume an unverified alias works.
- Codex invokes Claude from the repository in non-interactive mode and waits for the final review result. Restrict tool permissions to report-only work, allowing artifact writes only in the directories described below; omitting `--fix` alone is not a permission boundary.
- Count a review as complete only after successful execution, receipt of a valid final report, and verification that it covers the required stable change set, including applicable untracked files. A launch acknowledgement, exit code alone, or an empty response is not review evidence. A valid report with no findings is acceptable.
- If Claude cannot be invoked or the review is incomplete (timeouts, failed/skipped/degraded results, missing coverage, or permission denials preventing required coverage), prepare a review handoff, report the failure, and stop the review gate until an actual complete report is available. Never claim that a review ran automatically when it did not.

### Local Review Artifacts and Session History

- Keep review handoffs, raw reports, and finding dispositions under `docs/planning/reviews/issue-<number>/`. This directory must remain Git-ignored and untracked. Record any additional temporary run directories created by the review skill; allow only issue-owned review artifacts there.
- Keep the tracked human-facing records separate from temporary review artifacts, using the path and retention defined in Human-Facing Result Reports.
- During active work, keep session names/IDs, exact resume commands, and coverage metadata in the existing Issue-owned review artifacts. Before cleanup, preserve the durable review coverage and finding dispositions in the tracked records and PR without private session metadata. Retain native Claude session history; do not create a second human-facing report to duplicate it.
- Before cleanup, verify that the Issue index, all relevant PR records and PR descriptions contain the required durable evidence and have no links to artifacts scheduled for deletion. If either check fails, retain the temporary artifacts and report cleanup as incomplete.
- Record the Issue/subtask, command, reviewed base and HEAD, staged/unstaged diff snapshot and applicable untracked files, validation results, actual coverage and limits, findings and dispositions, and Claude session name/ID. Keep secrets and credentials out of these artifacts.
- Do not force-add, commit, or upload raw review artifacts or transcripts to GitHub. Preserve the durable implementation and verification summary, review coverage, and finding dispositions in the PR description without copying the raw reports.
- After confirming that all PRs belonging to the Issue are merged, the Issue is closed, and durable evidence is preserved in the PR records and descriptions, delete only that Issue's review directory and recorded temporary review artifacts. Do not clean up Issue-wide review evidence after an intermediate PR. Verify cleanup; report any remaining artifacts instead of claiming deletion succeeded.
- Run reviews using the same local Claude user/configuration directory the user uses, with session persistence enabled. Do not use `--no-session-persistence` or otherwise disable session history. Give each review round an identifiable name, such as `AMUQ-8-1-review-1` or `AMUQ-8-final-review-1`.
- Report the session name, ID, and exact `--resume` command with the repository working directory so the user can inspect the review in Claude CLI. Verify the executable or its resolution method; do not assume `claude` is on PATH or rely only on a version-pinned extension path for retained instructions. Do not purge native history or change its retention settings during cleanup; availability remains subject to Claude's retention settings.

## Sources of Truth

Apply this priority order:

1. Current GitHub Issue
2. Approved implementation-ready unified plan
3. Approved requirements-only unified plan
4. Approved Figma designs and `docs/DESIGN.md`
5. `docs/STRATEGY.md`
6. Local-only `docs/planning/project-handoff.md` for approved discovery decisions not superseded by a source above
7. Relevant `docs/solutions/` — documented solutions to past bugs, best practices, and workflow patterns, organized by category with YAML frontmatter such as `module`, `tags`, and `problem_type`; consult it when implementing or debugging a documented area
8. Existing repository conventions

For Git delivery sequencing only, use the approved PR scope table and order in the tracked Issue index. Local operational plans are supporting notes and do not override the product sources above.

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
- For documentation-only changes without source, executable configuration, or dependency changes, check Markdown, links, and consistency of rules, command names, and approval gates instead of rerunning product tests, type checking, or builds. State this scope and checks not run; changes to executable behavior follow the normal validation requirements.

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

1. Run `/ce-setup` to inspect and initialize the environment. Report the result and obtain explicit user approval before running `/ce-strategy`.
2. Run `/ce-strategy` to create or update `docs/STRATEGY.md` with target users, problem, value, MVP objective, success criteria, and exclusions. Report the output and obtain explicit user approval before Stage 2.

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
- For approved branch preparation after a merge, use the bounded status-only checkpoint preservation procedure in Stage 6.4 if a verified post-commit checkpoint is the sole dirty file. Other or unverified changes still block branch operations.
- Fetch remote changes, update `main` using fast-forward only, and create `<type>/<issue-number>-<imperative-verb>-<short-scope>` with `git switch`.
- Divide the Issue into ordered, independently verifiable subtasks labeled `<issue-number>-<sequence>` (e.g., `8-1`, `8-2`). These are internal work units, not additional GitHub Issues.
- Plan small, independently verifiable PRs before implementation, normally one per approved subtask. Obtain approval for their scopes, dependencies, order, and review coverage. Each PR targets `main`; prepare the next branch from updated `main` only after the preceding PR is merged and the next start is approved. Retain the Issue number and use a distinct scope suffix; group progress in the Issue index rather than an Issue integration branch. Keep one PR for an Issue that already fits one coherent change. An approved split does not authorize child Issues. Use a separate PR record for each approved scope and retain a short parent Issue index.
- For each subtask, define scope, dependencies, acceptance criteria, and applicable verification.
- Capture `issue-start-sha` from `main` before creating the first implementation branch, record it in the tracked Issue index included in the first PR, and record each PR's own starting SHA in its tracked PR record. Keep the original Issue baseline across intermediate merges so the final review covers the cumulative Issue, not just the last PR.
- Before the first MVP implementation, record the pre-implementation `mvp-start-sha`, its scope, and supporting Git evidence in `docs/issue-reports/mvp-review-baseline.md`, and link it from the first MVP Issue report and PR. For an MVP already in progress, verify and record that baseline in the same file from Git history before Stage 7; track an outstanding baseline in the active tracked Issue report until recorded; resolve uncertainty with the user instead of guessing or using the current HEAD.
- Present the subtask plan, exclusions, execution order, tests, risks, and verification commands; request approval before starting.
- Work on only one approved subtask at a time. Obtain explicit approval before beginning the next.

#### 6.2 Implement

Implement one approved subtask at a time directly in Codex. Do not invoke `/ce-work` because it may create implementation commits before independent review. Follow this TDD loop for every testable behavior change:

1. Write the smallest relevant test.
2. Run it and observe the intended failure.
3. Write the minimum implementation.
4. Confirm the test passes.
5. Refactor while keeping tests green.

Do not write production behavior before the corresponding test failure. Do not use another implementation orchestrator, including `lfg`, for this Issue delivery loop; Codex performs the implementation steps directly.

For non-trivial defects or unclear root causes, use `/ce-debug` in diagnosis-only mode if the chosen path cannot commit, push, or create a PR. Then implement through the TDD/review gates and rerun affected validation. Diagnosis does not authorize implementation commits.

For non-trivial changes, run `/ce-simplify-code` without changing approved behavior, provided its execution does not commit. Apply the Validation Policy to the current subtask.

For UI changes, use `/impeccable polish` only when refinement remains after audit. Never run `/ce-polish` unless the user explicitly requests it for a specific implemented screen.

#### 6.3 Review and Learn

##### 6.3.1 Subtask Review and Commit Loop

For each subtask, in this order:

1. Codex completes implementation and verification without committing, including report and checkpoint drafts for review. Record `HEAD`, the changed-file list, staged and unstaged diffs, and every applicable untracked file with its content or new-file patch and hash.
2. Hand Claude Code the subtask scope, acceptance criteria, changed files, and validation results. Request native `/code-review high` without `--fix` or `--comment`, focused on the current subtask's uncommitted changes relative to `HEAD` and any new files. Supply untracked contents explicitly because normal Git diffs omit them.
3. Verify actual coverage against the recorded changed/untracked file list and reviewed content. Native `/code-review` may also include earlier branch commits. Do not count a review that missed a required file or the current subtask as complete. Report material findings about earlier subtasks separately rather than silently ignoring them.
4. Codex validates findings against the code and requirements. Fix and re-review P0/P1 issues. Fix P2/P3 issues only when clear, safe, verified, and in scope; otherwise record their disposition.
5. Rerun affected validation after fixes. Send Claude the fixes and the disposition of every finding with supporting reasons, including decisions that no change is needed or that a finding is deferred. Obtain the targeted independent re-review defined above before reporting to the user, even when no code was changed or the first review had no findings. This final check confirms the final scope and report/checkpoint finalization; a second broad search is not required.
6. Apply only reviewed report/checkpoint finalization, ensuring tracked report changes passed the required review. Brief the user on outcome, findings and resolutions, verification evidence, deferred findings, and risks, and link the relevant PR record and Issue index. **Stop and request explicit user approval to commit this subtask.**
7. After approval, verify that the proposed staged diff matches the reviewed and approved changes; stage only those changes and create the local commit using the Git Rules. Do not include unrelated or unreviewed work.
8. Record the approved commit SHA in the checkpoint under the global `status.md` rules, queue it for the next cohesive reviewed tracked-report update, and report the SHA to the user. If approved subtasks remain within this PR, obtain explicit approval for the next subtask and repeat this loop. Once this PR's subtasks are committed, complete Stage 6.4 before seeking approval to start the next PR's scope. For the final PR, complete Stage 6.3.2 before Stage 6.4.

##### 6.3.2 Final Issue Review

After all planned subtasks are approved and committed, and before publishing the final PR, complete the steps below. Earlier PRs may already be merged after their own review and approval gates; they do not each require this cumulative review.

1. Run applicable Issue-level and integration validation across the combined changes.
2. Have Claude Code run `/compound-engineering:ce-code-review mode:agent depth:full base:<issue-start-sha>` against the cumulative Issue diff through the final PR HEAD, using the Issue, U-IDs, approved plans, design, and project guardrails. Verify coverage of every earlier merged PR and the final PR, preserve actual merge-result SHAs, and identify unrelated intervening changes without excluding their relevant integration effects. An empty or last-PR-only diff is insufficient. Apply the execution, completion, artifact, and session rules above.
3. Codex verifies findings, using the diagnosis-only `/ce-debug` path above before fixes when the root cause is unclear. Fix P0/P1 issues; handle P2/P3 findings as in the subtask review policy. Revalidate and obtain native `/code-review high` re-review of the final changes and all dispositions before requesting approval to commit the final-review fixes.
4. **Stop and request explicit user approval before each final-review fix commit.** Commit only reviewed and approved changes, and recheck for remaining blockers.
5. Run `/ce-compound` for reusable, non-trivial learning; skip trivial or duplicate documentation. If it changes files, obtain native `/code-review high` review, validate those changes, request approval, and commit them before the PR gate. Do not allow this skill to auto-commit or push.
6. Record final review coverage, resolved and deferred findings, verification evidence, remaining risks, and `/ce-compound` results in the relevant PR records. Keep a short complete Issue review status and links in the Issue index. Obtain native `/code-review high` review of the final record/index/checkpoint changes and exact-change commit approval before the PR gate, including when the complete Issue CE review has no findings.

The final Issue review is required even when every subtask passed its own review. Findings affecting an earlier merged PR must be resolved through an approved follow-up change, normally in the final PR, rather than by rewriting merged history. Keep the Issue open until every required delivery and the cumulative review are complete.

#### 6.4 Handoff and Merge

For each PR, after its subtask review, validation, and approved commits, give the user a handoff following the global Issue Reporting requirements. For the final PR, also complete the final Issue review first. Scope intermediate handoffs to the current PR and explicitly mark cumulative Issue review as pending; the final handoff covers the complete Issue. This is a user-facing report, not text to copy wholesale into the PR. Include:

- Completed outcomes and requirement IDs; three to five files/functions to inspect with their responsibilities and important conditions; main changes grouped by responsibility
- Red/Green evidence and summarized verification, including E2E, authorization/concurrency checks, browser QA, Figma comparison and UI audit results when applicable; clearly mark checks not run
- Subtasks and their approved commit SHAs
- Subtask and final Claude review results, findings and dispositions, coverage, and reviewed base and head SHAs
- Claude review session names, IDs, and resume commands for the local handoff only; exclude these and private paths from the PR
- `/ce-compound` result
- Links to the relevant PR record and Issue index for user review; keep local-only information out of the PR description

Ensure all changes intended for the PR have passed the required review, validation, and commit approval gates. Uncommitted or unreviewed source, report, or configuration changes block PR creation. The sole post-commit checkpoint exception below preserves a clean tree for approved publication or approved post-merge branch preparation without adding a status-only commit.

If the only remaining change is a verified agent-owned post-commit `status.md` checkpoint, save and hash an exact copy in an Issue-owned ignored temporary artifact outside directories scheduled for cleanup. Temporarily restore only `status.md` from the approved HEAD without staging or committing it, then verify the approved range and fully clean working tree before the approved publication or post-merge branch preparation. In a `finally` path on success or failure, restore the saved checkpoint and refresh it with verified operation results and the actual current branch; verify restoration before deleting the backup. Do not clean up outstanding checkpoint backups, use this procedure for other files or unverified edits, or discard the only copy. Batch the restored checkpoint into the next cohesive reviewed commit under the global status rules.

Stop and request explicit approval to create the PR. Do not paste full successful logs or rely on the CLI transcript as the sole durable record.

After approval, verify the approved commit range and clean working tree, then run `/ce-commit-push-pr babysit:off archive:off` to push and create or update the PR. Do not allow the skill to create additional commits or modify unapproved changes. Keep the PR title and section headings in English, and write a concise Korean implementation and verification summary. Follow the fixed Outcome field order in `.github/pull_request_template.md`. Fill its Records field with links to both the relevant `docs/issue-reports/issue-<number>/<sequence>-<scope>.md` and Issue index at the approved PR head commit. Verify that both files exist in that pushed commit; do not link to ignored local reports or substitute document links for the required PR summary. For an approved multi-PR Issue, each PR includes its own record; publish other records only when they exist in that reviewed commit. Do not merge automatically.

Treat recorded subtask SHAs as local/PR-history review references; they may differ from the commits on `main` after Rebase and merge. Record the reviewed base and scope in the tracked PR record; commit-pinned record links identify the reviewed head publicly. Omit standalone `Reviewed range` and `Pull request` fields from the PR description. Keep operational metadata in local review artifacts and preserve PR links in the Issue index and status checkpoint. After merge, verify the actual merge-result SHA and refresh `status.md` with that result and PR URL. The PR commit list and merge event provide the public Git references. The merged PR record retains the approved PR-head evidence, while the PR merge event and checkpoint record the actual merge result; no later Issue commit is required solely to synchronize report SHAs. Do not rewrite approved commits merely to synchronize report SHAs.

After explicit merge approval, use `Rebase and merge`. For an approved multi-PR Issue, use `Refs #<number>` on intermediate PRs and reserve `Closes #<number>` for the final PR that satisfies the whole Issue. Keep the Issue open and prepare the next approved scope from updated `main`, after its separate start approval. Review and validate each PR's actual changes and dependencies; earlier review of a different branch or scope does not prove this PR works. Follow the approved delivery order in the tracked Issue index and complete Stage 6.3.2 before final publication. After the final PR, brief the next Issue and wait for approval before starting it.

### Stage 7: MVP Completion

After all planned MVP Issues are merged:

1. Apply the Validation Policy to the full MVP and all critical flows.
2. Run `/impeccable audit` across the implemented UI and compare it with the approved designs.
3. Report findings and scope any required fixes. Obtain approval and update affected plans or designs when necessary, create follow-up Issues through Stage 5, and deliver fixes through Stage 6 rather than modifying `main` directly. All Stage 7 remediation changes, including plan, design, and report documents, require independent Claude review and explicit approval of the exact commit changes; the Stages 1–5 planning-only exception does not apply. Then rerun affected validation.
4. Request an independent, report-only Claude Code `/compound-engineering:ce-code-review mode:agent depth:full base:<mvp-start-sha>` of the complete MVP against the original requirements, design, and implementation plan. Verify that the recorded baseline predates the first MVP implementation and that the reviewed file set covers the complete MVP; a blank diff is not complete MVP coverage. Apply the execution, completion, artifact, and session rules above; process any resulting fixes through the same review-before-commit gates.
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
- Keep `docs/planning/` local-only and ignored by Git. Do not force-add its files; retain them on disk when removing existing tracking. This rule does not apply to `docs/plans/`.
- Keep operational plans for PR splitting and merge sequencing in ignored `docs/planning/`. Tracked agent instructions may name `docs/planning/active-work.md` solely as the conditional discovery pointer defined in Core Rules. Keep Issue-specific local plans and machine-local details out of tracked reports and public PR descriptions. Product requirements and implementation plans remain in `docs/plans/`.
- Apply the paths and retention in Human-Facing Result Reports: track the short Issue index and Korean PR records with related changes through normal review and approval gates; keep raw review and session artifacts Git-ignored.
- Commit cohesive completed units using an existing Gitmoji and a capitalized Conventional Commit type.
- Keep PR titles in English with a capitalized Conventional Commit type such as `Feat:` or `Docs:`, and omit emoji from PR titles. Keep Gitmoji in commit titles.
- Split completed work into commits by concrete task (for example, a schema addition, a UI correction, or a tooling change), rather than combining all changes for an Issue into one commit. Keep code and its directly related tests together; group inseparable dependencies so a commit preserves their contract.
- For work tied to a GitHub Issue, end every commit title with `(#<issue-number>)`. Do not put plan U-IDs such as `(U02)` in commit titles; keep U-IDs in plans and implementation reports.
- Name non-Issue branches `<type>/<imperative-verb>-<short-scope>` and describe the work itself instead of a workflow stage or stage number.
- For Issue branches, use `<type>/<issue-number>-<imperative-verb>-<short-scope>`.
- Do not push, create a PR, or merge without explicit user approval.
- This is a solo project. Do not run `ce-babysit-pr` or otherwise monitor a Pull Request unless the user explicitly requests monitoring in the current turn. After creating or updating a Pull Request, report it immediately and wait for user review.
- Use `Rebase and merge` by default. Do not choose another merge strategy without explicit approval.
- Keep approved subtask commits local until that PR's independent review, validation, commit approval, and separate PR approval gate are complete. Intermediate PRs may then be published and merged; the final PR additionally requires the complete Issue review. Do not amend, squash, or rewrite reviewed commits without explicit approval and any required re-review.
