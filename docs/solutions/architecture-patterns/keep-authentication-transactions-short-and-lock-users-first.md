---
title: Keep authentication transactions short and lock users first
date: 2026-09-28
last_updated: 2026-10-19
category: architecture-patterns
module: authentication
problem_type: architecture_pattern
component: api_layer
severity: high
applies_when:
  - Multiple authentication flows update the same user and token rows concurrently
  - Password hashing or verification is combined with PostgreSQL transactions
related_components: [database, authentication, background_job]
tags: [authentication, postgresql, transactions, deadlocks, row-locking, argon2, token-expiry, read-committed, snapshots]
---

# Keep authentication transactions short and lock users first

## Context

Issue [#8](https://github.com/sysysysyb/AMUQ/issues/8) added concurrent email verification, verification resend, login, and password-reset flows. Verification originally locked an authentication token before updating its user, while resend locked the user before superseding that user's tokens. Two requests could therefore each wait for a row held by the other and end in a PostgreSQL deadlock.

Password hashing and verification also use deliberately expensive Argon2 work. Performing that work while a transaction holds a connection or row lock needlessly reduces the number of authentication requests the database can serve.

## Guidance

Use one global lock order for authentication mutations: lock the `users` row first, then conditionally consume or supersede `auth_tokens`, and only then update identities or sessions. `verifyEmailAddress`, `resendVerificationEmail` and `requestPasswordReset` follow that order in `apps/api/src/modules/auth/service.ts`.

Lock acquisition and snapshot freshness are separate requirements. PostgreSQL 17's [Read Committed rules](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED) give each statement a snapshot when it starts. A token-issuance CTE that waits for a user lock still cannot find tokens inserted by another request after that snapshot. Locking the user inside that same CTE therefore does not serialize token supersession correctly across connections. Acquire the user lock in a separate `SELECT ... FOR UPDATE` statement, then run the eligibility check, token supersession and atomic token/outbox insertion in the next statement within the same transaction. The second statement sees the preceding issuer's commit. Keep this explicit boundary when consolidating SQL.

Bind the follow-up eligibility query to the ID returned by the locking statement, not just the email. An empty lookup locks no user: a registration committed between the two statements must not become an unlocked issuance target in the newer snapshot. `lockUserByEmail` returns that ID or `null`; both issuance paths still execute the same statements, and a null ID matches no candidate. A real-database regression creates an account immediately after the empty lookup and checks that the pending request creates no additional token or outbox entry.

Email-verification resend and password-reset requests preserve an identical query sequence for existing and unknown emails. Another deterministic regression in `apps/api/test/integration/auth-email-rate-limit.test.ts` holds a user lock on a separate connection, waits until both issuance requests are blocked, then releases it. Before the fix, both cases left two active tokens; after the fix each leaves one active token and one pending outbox entry. A pool limit of one connection per process does not prevent this ordering across API instances. Identical statements and a response-time floor do not guarantee identical latency under lock contention; the pre-existing account-enumeration timing risk remains outside this correction.

Keep Argon2 outside database transactions. `authenticatePassword` reads the current hash, verifies it without holding a transaction, then opens a short transaction and requires the locked identity to still have that same hash before creating the session. `resetPassword` rejects an unknown or expired token before hashing, then locks the user and atomically rechecks and consumes the token before replacing the password.

Treat time as mutable state whenever expensive work or lock waiting separates validation from mutation. Capture one time for the cheap early rejection, but read the clock again only after the user lock is acquired and use that fresh value in the atomic `expires_at` condition. Password reset therefore cannot accept a token that expired during Argon2 hashing. Email verification uses the same rule after waiting for the user lock.

For verification resend and password-reset issuance, consume the request rate limit first, then sample the clock again after acquiring the user lock. Use that issuance time consistently for the new token's creation and expiry, old-token supersession and the new outbox timestamps. Creating the token before the lock wait would shorten its usable lifetime. Both operations reuse the existing `AuthClock` and `readAuthClock` convention so production reads the current time while tests may inject a fixed date or a clock.

Protect these properties with small tests: assert the user-lock query happens before token mutation, advance the injected clock across the lock or hash boundary, and ensure invalid credentials do not open a transaction or run unnecessary hashing (`apps/api/src/modules/auth/service.test.ts`, `apps/api/test/integration/auth-password-reset.test.ts`). Also run a real PostgreSQL race test because a mocked query sequence cannot reproduce database lock behavior (`apps/api/test/integration/auth-email-rate-limit.test.ts`).

## Why This Matters

A consistent lock order prevents circular waits across sibling authentication flows. Short transactions return pooled connections promptly and prevent expensive password work from amplifying a login flood into database starvation. Rechecking the password hash, token state, and current time after that work preserves correctness if another request changes the account or the token expires concurrently.

## When to Apply

Apply this pattern whenever a new authentication operation touches `users` plus tokens, identities, or sessions. Before adding the transaction, inspect sibling flows and preserve their lock order. Keep CPU-heavy hashing, email-provider calls, and other external work outside the transaction, then revalidate the state and clock-dependent conditions that could have changed before committing.

## Related

- [Make authentication email outbox retries stable and race safe](./make-authentication-email-outbox-retries-stable-and-race-safe.md)
- [Issue #8](https://github.com/sysysysyb/AMUQ/issues/8)
