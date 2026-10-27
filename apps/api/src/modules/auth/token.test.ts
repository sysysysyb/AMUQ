import { describe, expect, it } from "vitest";

import {
  authTokenKeyId,
  createAuthToken,
  createOpaqueToken,
  deriveAuthToken,
  hashOpaqueToken,
} from "#api/modules/auth/token";

const authTokenSecret = "a".repeat(32);

describe("authentication tokens", () => {
  it("creates an unpredictable 256-bit token and stores only its SHA-256 hash", () => {
    const firstToken = createOpaqueToken();
    const secondToken = createOpaqueToken();

    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondToken).not.toBe(firstToken);
    expect(hashOpaqueToken(firstToken)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOpaqueToken(firstToken)).not.toContain(firstToken);
  });

  it.each([
    ["email_verification", 24 * 60 * 60 * 1_000],
    ["password_reset", 30 * 60 * 1_000],
  ] as const)("sets the approved %s lifetime", (purpose, lifetimeMs) => {
    const createdAt = new Date("2026-09-27T00:00:00.000Z");
    const tokenId = "9a268713-29db-4bfd-94c9-e74329cc17a9";

    const token = createAuthToken(purpose, authTokenSecret, createdAt, tokenId);

    expect(token.id).toBe(tokenId);
    expect(token.rawToken).toBe(
      deriveAuthToken(purpose, tokenId, authTokenSecret),
    );
    expect(token.rawToken).not.toBe(token.tokenHash);
    expect(token.createdAt).toEqual(createdAt);
    expect(token.expiresAt).toEqual(new Date(createdAt.getTime() + lifetimeMs));
  });

  it("derives a stable token for worker retries without storing the raw value", () => {
    const tokenId = "9a268713-29db-4bfd-94c9-e74329cc17a9";

    const first = deriveAuthToken(
      "email_verification",
      tokenId,
      authTokenSecret,
    );
    const retry = deriveAuthToken(
      "email_verification",
      tokenId,
      authTokenSecret,
    );
    const reset = deriveAuthToken("password_reset", tokenId, authTokenSecret);

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(retry).toBe(first);
    expect(reset).not.toBe(first);
  });

  it("identifies token keys without storing the secret", () => {
    expect(authTokenKeyId(authTokenSecret)).toMatch(/^[0-9a-f]{16}$/);
    expect(authTokenKeyId(authTokenSecret)).not.toContain(authTokenSecret);
    expect(authTokenKeyId("b".repeat(32))).not.toBe(
      authTokenKeyId(authTokenSecret),
    );
  });
});
