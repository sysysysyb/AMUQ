import { afterAll, beforeEach, describe } from "vitest";

import { createDatabasePool } from "#backend/db/database";
import { assertTestDatabaseUrl } from "#backend-test/support/test-database";

export const createTestDatabase = (cleanupScope: "file" | "suite") => {
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

  const registerCleanup = () => {
    beforeEach(async () => {
      await resetDatabase();
    });
    afterAll(async () => {
      await resetDatabase();
      await admin?.end();
    });
  };

  const fixture = { admin, connectionString, databaseTest };
  if (cleanupScope === "file") {
    registerCleanup();
    return fixture;
  }

  return {
    ...fixture,
    databaseTest: (name: string, tests: () => void) =>
      databaseTest(name, () => {
        registerCleanup();
        tests();
      }),
  };
};
