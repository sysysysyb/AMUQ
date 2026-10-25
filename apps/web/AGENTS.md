<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Frontend conventions

Tailwind, `lib/cn.ts`, and `class-variance-authority` below apply after Issue #8 PR3 introduces them. Earlier PRs retain the current web code and dependencies; these conventions do not authorize installing tools or converting styles outside the approved PR scope.

- Start components in the nearest feature. Promote them to `components/ui` only when a second feature reuses them, the approved design system defines them as shared, or they are stable app-wide primitives. Search existing feature and shared components before adding another.
- Use `@web/...` aliases for imports within the web workspace, including nearby feature modules and tests, so the owning feature is clear. Keep Next.js, React and other package imports as package specifiers.
- Use Tailwind CSS v4 for all styling, including existing components and global styles. Express component styles as Tailwind utilities; use Tailwind's CSS-first `@theme`, `@layer base`, and `@apply` where global rules require them. Do not add plain feature CSS selectors. Preserve approved rendering and accessibility during conversion.
- Use the single `lib/cn.ts` helper for conditional or caller-overridable classes. Use `class-variance-authority` only for real reusable variants; do not add speculative abstractions.
- Preserve `300ms ease-in-out` interaction transitions and reduced-motion accessibility.
- Install new dependencies with pnpm in the owning workspace package, using the latest stable version verified against the official registry. Pin exact versions and follow the documentation shipped with that version or its official versioned documentation.
