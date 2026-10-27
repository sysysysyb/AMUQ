import { describe, expect, it } from "vitest";

import {
  deriveSignupCode,
  deriveSignupProof,
  digestSignupCode,
} from "#api/modules/auth/signup-token";
import { deriveAuthToken } from "#api/modules/auth/token";

describe("signup secret material", () => {
  it("reconstructs six digits with purpose separation and keyed digests", () => {
    const id = "348e69b8-f613-4a83-8158-be31163ff1b7";
    const secret = "a".repeat(32);
    const code = deriveSignupCode(id, secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(deriveSignupCode(id, secret)).toBe(code);
    expect(digestSignupCode(id, code, secret)).not.toBe(
      digestSignupCode("other", code, secret),
    );
    expect(digestSignupCode(id, code, secret)).not.toBe(
      digestSignupCode(id, code, "b".repeat(32)),
    );
    expect(deriveSignupProof(id, id, secret)).not.toBe(
      deriveAuthToken("email_verification", id, secret),
    );
    expect(deriveSignupProof(id, id, secret)).not.toBe(
      deriveSignupProof(id, "other", secret),
    );
  });
});
