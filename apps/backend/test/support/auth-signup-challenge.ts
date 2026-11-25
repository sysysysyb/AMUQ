import { randomUUID } from "node:crypto";

import { deliverPendingEmails } from "#backend/jobs/send-email";
import { issueSignupChallenge } from "#backend/modules/auth/signup-challenge";
import { deriveSignupCode } from "#backend/modules/auth/signup-token";
import { hashOpaqueToken } from "#backend/modules/auth/token";
import { type ResendEmail } from "#backend/modules/email/resend";
import { setupAuthDatabase } from "#backend-test/support/auth-database";
import {
  authRateLimitSecret,
  authTokenSecret,
} from "#backend-test/support/auth-test-secrets";

export const setupSignupChallenge = () => {
  const { admin, connectionString, databaseTest } = setupAuthDatabase();

  const now = new Date("2026-10-21T00:00:00.000Z");

  const options = { authTokenSecret, rateLimitSecret: authRateLimitSecret };

  const at = (seconds: number) => () =>
    new Date(now.getTime() + seconds * 1_000);

  const email = "learner@example.com";

  const start = (
    seconds = 0,
    address = "203.0.113.1",
    operation = randomUUID(),
  ) =>
    issueSignupChallenge(
      admin!,
      email,
      operation,
      address,
      options,
      at(seconds),
    );

  const codeFor = async (attemptToken: string) => {
    const result = await admin!.query<{ id: string }>(
      `SELECT code.id FROM auth_signup_codes code JOIN auth_signup_attempts attempt ON attempt.id = code.attempt_id
     WHERE attempt.token_hash = $1 ORDER BY code.created_at DESC LIMIT 1`,
      [hashOpaqueToken(attemptToken)],
    );
    return deriveSignupCode(result.rows[0]!.id, authTokenSecret);
  };

  const deliver = (
    sendEmail: (email: ResendEmail) => Promise<{ providerMessageId: string }>,
    seconds = 1,
    secret = authTokenSecret,
  ) =>
    deliverPendingEmails(
      { executeSql: (sql, values) => admin!.query(sql, values) },
      {
        authTokenSecret: secret,
        authTokenPreviousSecret: authTokenSecret,
        clock: at(seconds),
        from: "AMUQ <account@example.com>",
        sendEmail,
        webOrigin: "https://example.com",
      },
    );

  return {
    admin,
    connectionString,
    databaseTest,
    now,
    options,
    at,
    email,
    start,
    codeFor,
    deliver,
  };
};
