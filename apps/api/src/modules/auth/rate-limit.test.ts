import { describe, expect, it } from "vitest";

import { hashRateLimitSubject } from "#api/modules/auth/rate-limit";

describe("authentication rate-limit subjects", () => {
  it("stores an environment-secret HMAC instead of the raw subject", () => {
    const subject = "learner@example.com";
    const first = hashRateLimitSubject("identifier", subject, "a".repeat(32));
    const second = hashRateLimitSubject("identifier", subject, "b".repeat(32));

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain(subject);
    expect(second).not.toBe(first);
    expect(
      hashRateLimitSubject("client_address", subject, "a".repeat(32)),
    ).not.toBe(first);
  });
});
