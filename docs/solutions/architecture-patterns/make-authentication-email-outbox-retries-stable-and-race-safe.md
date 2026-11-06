---
title: Make authentication email outbox retries stable and race safe
date: 2026-09-27
last_updated: 2026-11-07
category: architecture-patterns
module: auth-email-delivery
problem_type: architecture_pattern
component: background_job
severity: high
applies_when:
  - Authentication tokens and their email jobs must be committed atomically
  - Retries reconstruct a provider request without persisting the raw token
  - Multiple workers can attempt to deliver the same pending outbox row
  - A provider request can outlive the token or idempotency deadline
  - Legacy pending rows must be upgraded without sending unverifiable payloads
related_components: [authentication, messaging, database]
tags: [auth, email-outbox, idempotency, retries, concurrency, token-security, postgresql, resend]
---

# Make authentication email outbox retries stable and race safe

## Context

Authentication email delivery crosses three state boundaries: PostgreSQL, the email provider's idempotency store, and token-signing configuration. Reusing a stable provider key is not enough if a retry can rebuild a different recipient, link, sender, or body. Likewise, selecting a pending row without a durable claim lets overlapping workers send or overwrite each other's results.

Issue [#8](https://github.com/sysysysyb/AMUQ/issues/8) exposed related edge cases:

- Mutable source data could produce a different provider payload under the same idempotency key.
- A stopped worker could resume after another worker reclaimed and completed the row.
- Time spent preparing a payload could consume the remaining token or provider-idempotency window.
- Rotating the signing secret before the first send could reconstruct an invalid link.
- A rolling deployment could make an older worker mistake a newer signing-key identifier for corrupt data.
- Token cleanup or supersession could overwrite a row while another worker still owned its active delivery claim.
- Adding required key metadata directly could fail when upgrading a database with legacy pending rows.

These failures must be handled as one delivery invariant. Fixing only the provider key, row lock, or token storage leaves another boundary inconsistent.

## Guidance

Create the token and outbox row in one data-modifying SQL statement so neither can commit alone (`apps/backend/src/modules/auth/service.ts`). Persist the token hash and a non-secret signing-key identifier, never the raw token or signing secret. The raw token can be reconstructed deterministically from its purpose, ID, and matching secret (`apps/backend/src/modules/auth/token.ts`).

Before the first provider call, hash a deterministic serialization of every provider-request input, including the idempotency key. Every retry must reconstruct the same inputs and match that fingerprint; payload drift becomes a terminal failure before any external call (`apps/backend/src/jobs/send-email.ts`). Keep the provider idempotency key tied to the durable outbox ID (`apps/backend/src/jobs/send-email.ts`).

Claim work atomically with `FOR UPDATE ... SKIP LOCKED`, increment the attempt count in the same statement, and return the claim's `updated_at` value (`apps/backend/src/jobs/send-email.ts`). Treat that timestamp as a compare-and-swap fencing token. Fingerprint writes, terminal failures, provider success, and provider failure must all require the same claim value. Renew the claim immediately before the provider call (`apps/backend/src/jobs/send-email.ts`). A worker whose claim expired then observes a stale result and exits without sending or changing state.

Apply the same retry-eligibility predicate to every query that can claim or retire a pending row (`apps/backend/src/jobs/send-email.ts`). A deadline or consumed token does not cancel the fencing rule: terminal cleanup must wait until the active claim becomes retry-eligible. Resend supersession is stricter and changes only rows with `attempt_count = 0` (`apps/backend/src/modules/auth/service.ts`).

Read the clock again after payload preparation and claim renewal. Add the provider request timeout to the current time, then reject a token or idempotency key that cannot remain valid for the whole call (`apps/backend/src/jobs/send-email.ts`). Apply the same deadline decision before retrying an unknown signing-key identifier, so already-expired work becomes terminal instead of retrying forever (`apps/backend/src/jobs/send-email.ts`).

During secret rotation, retain the previous secret for at least the longest outstanding token lifetime. Select the current or previous secret by comparing their non-secret identifiers to the identifier recorded when the token was issued (`apps/backend/src/jobs/send-email.ts`). If a non-null identifier matches neither secret, do not send, but leave still-valid work retryable because a newer deployment may know that key. A legacy null identifier is unrecoverable and terminal; an expired unknown-key row is also terminal.

For existing databases, add new metadata as nullable, retire legacy pending rows whose signing key cannot be recovered, and only then install the constraint that every pending row has a key identifier (`apps/backend/drizzle/0002_empty_master_mold.sql`). Sent or already-failed historical rows may remain without that identifier because they will not be delivered again.

## Why This Matters

The outbox is the durable record that connects a database transaction to an external side effect. Its database state must describe what the provider could actually have accepted, including after a lost response, concurrent polling, worker suspension, configuration change, or deployment migration.

A payload fingerprint protects provider idempotency semantics. Atomic claiming prevents ordinary double selection. Fencing prevents an older claimant from acting after its lease expires. The fresh deadline check prevents starting an external call that cannot finish within the approved window. The key identifier preserves token validity across a controlled secret rotation without storing the secret or raw token.

## When to Apply

- A transactional outbox drives an external API with provider-side idempotency.
- The provider may accept a request even when the client loses the response.
- More than one worker can poll or reclaim pending rows.
- Request content is reconstructed from mutable records or runtime configuration.
- A secret rotation can occur while derived values remain valid.
- A schema upgrade adds metadata required only for future processing.

## Examples

- Forced outbox-insert failure leaves neither token nor outbox row (`apps/backend/test/integration/database.test.ts`).
- A lost provider response retries with an unchanged payload across secret rotation (`apps/backend/test/integration/database.test.ts`).
- A rotation before the first delivery preserves the originally issued link (`apps/backend/test/integration/database.test.ts`).
- Changed recipient data stops before the provider is called (`apps/backend/test/integration/database.test.ts`).
- Two real PostgreSQL connections produce only one active delivery (`apps/backend/test/integration/database.test.ts`).
- A reclaimed row cannot be overwritten or sent by the expired claimant (`apps/backend/test/integration/database.test.ts`).
- Consumed-token cleanup and deadline cleanup do not steal an active claim (`apps/backend/test/integration/database.test.ts`).
- Resend supersession does not overwrite an active delivery (`apps/backend/test/integration/auth-email-rate-limit.test.ts`).
- A delay during fingerprint preparation is included in the final deadline decision (`apps/backend/src/jobs/send-email.test.ts`).
- An unknown newer key retries only while the token remains deliverable (`apps/backend/src/jobs/send-email.test.ts`).
- A legacy pending row is retired before the new invariant is enforced (`apps/backend/test/integration/database.test.ts`).

## Related

- [Issue #8 — Add secure authentication and account access](https://github.com/sysysysyb/AMUQ/issues/8)
- [Authenticate client addresses across hosted proxies](authenticate-client-address-across-hosted-proxies.md)
