import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { buildServer } from "#backend/http/server";
import { hashPassword } from "#backend/modules/auth/password";
import {
  authenticatePassword,
  type AuthMutationOptions,
} from "#backend/modules/auth/service";
import { deriveSignupCode } from "#backend/modules/auth/signup-token";
import { hashOpaqueToken } from "#backend/modules/auth/token";
import {
  authRateLimitSecret,
  authTokenSecret,
} from "#backend-test/support/auth-test-secrets";
import { createTestDatabase } from "#backend-test/support/database-fixture";

export { authTokenSecret } from "#backend-test/support/auth-test-secrets";

export const completePasswordSignup = async (
  database: Pool,
  email: string,
  password: string,
  clientAddress: string,
  options: AuthMutationOptions = {
    authTokenSecret,
    rateLimitSecret: authRateLimitSecret,
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
  const { admin, connectionString, databaseTest } = createTestDatabase("file");

  const createVerifiedPasswordLogin = async (
    email: string,
    password: string,
    clientAddress: string,
    now: Date,
  ) => {
    const options = {
      authTokenSecret,
      rateLimitSecret: authRateLimitSecret,
    };
    await completePasswordSignup(
      admin!,
      email,
      password,
      clientAddress,
      options,
      now,
    );
    const login = await authenticatePassword(admin!, email, password, now);
    if (!login || login.status !== "authenticated") {
      throw new Error("Password account setup failed");
    }
    return login;
  };

  return { admin, connectionString, createVerifiedPasswordLogin, databaseTest };
};
