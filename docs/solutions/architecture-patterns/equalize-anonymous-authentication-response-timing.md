---
title: Equalize anonymous authentication response timing
date: 2026-09-29
last_updated: 2026-10-08
category: architecture-patterns
module: authentication
problem_type: architecture_pattern
component: api_layer
severity: high
applies_when:
  - Anonymous authentication endpoints intentionally return the same response for existing and missing accounts
  - Account-dependent database work can still make those responses observably different
related_components: [database, authentication, testing_framework]
tags: [authentication, account-enumeration, timing, rate-limiting, postgresql, security]
---

# Equalize anonymous authentication response timing

## Context

Returning the same status and body does not by itself prevent account enumeration. Issue [#8](https://github.com/sysysysyb/AMUQ/issues/8) initially returned the same `202` for registered and unregistered email addresses, but the registered path also locked a user and updated token and outbox rows. Repeated duration measurements could therefore reveal which account existed.

## Guidance

Use the same application work shape before deciding whether a real account receives a token:

- Generate token material regardless of whether the account exists.
- Execute one parameterized transaction and one data-modifying CTE in both cases; let the candidate row make writes conditional inside PostgreSQL rather than returning early in application code (`apps/api/src/modules/auth/service.ts:313`, `apps/api/src/modules/auth/service.ts:458`).
- Keep the public status and body identical.
- Add a short minimum response duration at the HTTP boundary to absorb the remaining difference between a CTE that writes rows and one whose candidate is empty (`apps/api/src/modules/auth/routes.ts:39`, `apps/api/src/modules/auth/routes.ts:515`).
- Retain identifier and client-address rate limits so an attacker cannot cheaply collect a large timing sample.

The current pending implementation uses a 250 ms response floor for verification resend and password-reset request. That value is a protective floor, not a universal constant. If normal successful requests begin crossing it, measure production latency and raise the floor rather than assuming the original value still hides the two distributions.

## Why This Matters

Application-level early returns create a large, stable timing difference because one path skips row locks and writes. A common SQL shape narrows that difference; the response floor hides the smaller remaining database difference during normal operation. Rate limits then reduce the number of observations available to distinguish residual jitter.

No finite floor hides an unusually slow lock wait or database incident. Keep authentication transactions short, monitor endpoint latency by outcome internally without logging identifiers, and treat sustained requests beyond the floor as an operational signal.

## When to Apply

- Password-reset requests, verification-email resend, invitations, and account-recovery endpoints.
- Any anonymous endpoint whose response is intentionally account-agnostic but whose internal work depends on account existence or state.
- Flows where a background queue is not yet used to detach public response time from account-dependent work.

## Examples

- Unit coverage checks that registered and unregistered paths execute the same number of database statements (`apps/api/src/modules/auth/service.test.ts:165`).
- PostgreSQL-backed HTTP coverage checks that both verification-resend and password-reset responses reach the configured timing floor while preserving identical `202` bodies (`apps/api/test/integration/auth-password.test.ts:193`, `apps/api/test/integration/auth-password.test.ts:274`).

## Related

- [Keep authentication transactions short and lock users first](./keep-authentication-transactions-short-and-lock-users-first.md)
- [Authenticate client addresses across hosted proxies](./authenticate-client-address-across-hosted-proxies.md)
- [Issue #8](https://github.com/sysysysyb/AMUQ/issues/8)
