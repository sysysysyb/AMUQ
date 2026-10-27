import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe } from "vitest";
import { createDatabasePool } from "#api/db/database";
import { buildServer } from "#api/http/server";
import { hashPassword } from "#api/modules/auth/password";
import { type AuthMutationOptions } from "#api/modules/auth/service";
import { deriveSignupCode } from "#api/modules/auth/signup-token";
import { hashOpaqueToken } from "#api/modules/auth/token";
import { assertTestDatabaseUrl } from "#api-test/support/test-database";

export const authTokenSecret = "a".repeat(32);

export const completePasswordSignup = async (
  database: Pool,
  email: string,
  password: string,
  clientAddress: string,
  options: AuthMutationOptions = {
    authTokenSecret,
    rateLimitSecret: "r".repeat(32),
  },
  now = new Date(),
) => {
  const origin = "https://web.example";
  const server = await buildServer({
    environment: "test",
    auth: {
      ...options,
      database,
      allowedOrigins: [origin],
      webOrigin: origin,
      clock: () => now,
    },
  });
  const post = (url: string, payload: Record<string, unknown>) =>
    server.inject({
      method: "POST",
      url,
      payload,
      headers: { origin },
      remoteAddress: clientAddress,
    });
  try {
    const sent = await post("/auth/signup/challenges", {
      email,
      operationKey: randomUUID(),
    });
    assert.equal(sent.statusCode, 202, "Fixture challenge rejected");
    const attemptToken = sent.json().attemptToken as string;
    const code = await database.query<{ id: string }>(
      `SELECT code.id FROM auth_signup_codes code JOIN auth_signup_attempts attempt ON attempt.id = code.attempt_id WHERE attempt.token_hash = $1`,
      [hashOpaqueToken(attemptToken)],
    );
    const verified = await post("/auth/signup/challenges/verify", {
      attemptToken,
      code: deriveSignupCode(code.rows[0]!.id, options.authTokenSecret),
    });
    assert.equal(verified.statusCode, 200, "Fixture verification rejected");
    const completed = await post("/auth/signup/complete", {
      signupProof: verified.json().signupProof,
      password,
    });
    assert.equal(completed.statusCode, 200, "Fixture completion rejected");
    return completed.json() as { status: string };
  } finally {
    await server.close();
  }
};

// Historical verified passwords can predate today's signup length/complexity policy.
export const seedVerifiedPasswordAccount = async (
  database: Pool,
  email: string,
  password: string,
  now: Date,
) => {
  const user = await database.query<{ id: string }>(
    "INSERT INTO users (email, email_verified_at, created_at, updated_at) VALUES ($1, $2, $2, $2) RETURNING id",
    [email.toLowerCase(), now],
  );
  await database.query(
    `INSERT INTO auth_identities (user_id, provider, password_hash, verified_at, activated_at, created_at, updated_at)
     VALUES ($1, 'password', $2, $3, $3, $3, $3)`,
    [user.rows[0]!.id, await hashPassword(password), now],
  );
};

export const setupAuthDatabase = () => {
  const connectionString = process.env.TEST_DATABASE_URL
    ? assertTestDatabaseUrl(process.env.TEST_DATABASE_URL)
    : undefined;
  const databaseTest = connectionString ? describe : describe.skip;
  const admin = connectionString
    ? createDatabasePool(connectionString)
    : undefined;
  const resetDatabase = async () => {
    await admin?.query(
      "DROP TABLE IF EXISTS email_webhook_events, email_outbox, auth_signup_codes, auth_signup_attempts, auth_password_login_limits, auth_rate_limits, auth_oidc_flows, auth_link_sessions, auth_tokens, auth_sessions, auth_identities, users CASCADE",
    );
    await admin?.query(
      "DROP TYPE IF EXISTS email_delivery_status, auth_oidc_flow_mode, auth_token_purpose, auth_rate_limit_subject_kind, auth_rate_limit_scope, auth_provider CASCADE",
    );
    await admin?.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    await admin?.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  };

  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await resetDatabase();
    await admin?.end();
  });

  return { admin, connectionString, databaseTest };
};
