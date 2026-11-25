import { randomUUID } from "node:crypto";

import {
  issueSignupChallenge,
  verifySignupChallenge,
} from "#backend/modules/auth/signup-challenge";
import { deriveSignupCode } from "#backend/modules/auth/signup-token";
import { hashOpaqueToken } from "#backend/modules/auth/token";
import { setupAuthDatabase } from "#backend-test/support/auth-database";
import {
  authRateLimitSecret,
  authTokenSecret,
} from "#backend-test/support/auth-test-secrets";

export const setupSignupCompletion = () => {
  const { admin, connectionString, databaseTest } = setupAuthDatabase();

  const epoch = new Date("2026-10-21T00:00:00Z");

  const at = (seconds: number) => () =>
    new Date(epoch.getTime() + seconds * 1_000);

  const options = { authTokenSecret, rateLimitSecret: authRateLimitSecret };

  const password = "OwnerPass1234";

  const ownership = async (email = "owner@example.com", seconds = 0) => {
    const challenge = await issueSignupChallenge(
      admin!,
      email,
      randomUUID(),
      "203.0.113.1",
      options,
      at(seconds),
    );
    const result = await admin!.query<{ id: string }>(
      `SELECT code.id FROM auth_signup_codes code
     JOIN auth_signup_attempts attempt ON attempt.id = code.attempt_id
     WHERE attempt.token_hash = $1`,
      [hashOpaqueToken(challenge.attemptToken)],
    );
    const verified = await verifySignupChallenge(
      admin!,
      challenge.attemptToken,
      deriveSignupCode(result.rows[0]!.id, authTokenSecret),
      options,
      at(seconds + 1),
    );
    if (verified.status !== "verified")
      throw new Error("Expected ownership proof");
    return verified.signupProof;
  };

  return {
    admin,
    connectionString,
    databaseTest,
    epoch,
    at,
    options,
    password,
    ownership,
  };
};
