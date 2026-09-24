---
title: Authenticate client addresses across hosted proxies
date: 2026-09-25
category: architecture-patterns
module: web-api-proxy
problem_type: architecture_pattern
component: api_layer
severity: high
applies_when:
  - Browser traffic reaches an API through a separately hosted same-origin web proxy
  - The API cannot identify that proxy through a stable exclusive ingress CIDR
tags: [vercel, railway, client-ip, reverse-proxy, shared-secret, trust-boundary, https]
---

# Authenticate client addresses across hosted proxies

## Context

AMUQ routes browser traffic through a Vercel same-origin proxy before it reaches the Railway API. In that topology, the API's network peer is an intermediary, so the browser address cannot be derived safely from the nearest hop. Trusting generic forwarded headers would instead let direct API callers choose their own identity. Railway's [public networking specification](https://docs.railway.com/networking/public-networking/specs-and-limits) does not publish a stable, exclusive ingress CIDR contract, while Vercel documents a platform-overwritten [client-address header](https://vercel.com/docs/headers/request-headers) at the Web boundary.

## Guidance

Treat the browser address as a separate authenticated claim:

1. Keep Fastify's generic forwarded-header trust disabled (`apps/api/src/http/server.ts:71`).
2. At the Vercel boundary, read the platform-provided address, reject malformed production values, delete caller-provided internal headers, and overwrite them with the verified address and a shared secret (`apps/web/app/api/[...path]/route.ts:55`, `apps/web/app/api/[...path]/route.ts:80`).
3. At the API, accept that address only when it is a single valid IP and the secret matches; otherwise use the socket address (`apps/api/src/http/client-address.ts:21`).
4. Require the secret in production and require HTTPS for the upstream API so the credential is not sent in plaintext (`apps/api/src/config/environment.ts:13`, `apps/web/app/api/[...path]/route.ts:38`).

## Why This Matters

This separates transport metadata from the security subject later used by rate limits. Different browsers remain distinguishable even when they share a Vercel egress, and direct Railway callers cannot authenticate a forged address without the deployment secret.

The shared secret must be configured identically on both services. A mismatch intentionally falls back to the socket address, so deployment verification must confirm the end-to-end subject before security-sensitive rate limits rely on it.

## When to Apply

- Multiple managed proxies sit between a browser and an API.
- The client address affects rate limiting, abuse prevention, or another security decision.
- The hosting provider does not guarantee a stable exclusive ingress network.

Prefer a platform-native signed identity header when one is available. The shared-secret header is the minimum contract for this topology.

## Examples

- The Web proxy preserves two different platform client addresses across one upstream (`apps/web/app/api/[...path]/route.test.ts:80`).
- The API integration test accepts the authenticated address but falls back for a wrong secret or malformed address (`apps/api/test/integration/health.test.ts:25`).
- Production rejects an HTTP API origin before forwarding the secret (`apps/web/app/api/[...path]/route.test.ts:23`).

## Related

- [Issue #7](https://github.com/sysysysyb/AMUQ/issues/7)
- `docs/plans/2026-09-09-0037-feat-amuq-mvp-requirements-plan.md`
