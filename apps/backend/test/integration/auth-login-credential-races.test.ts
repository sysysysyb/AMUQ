import { Pool } from "pg";
import { expect, it } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import {
  finishPasswordLoginAttempt,
  reservePasswordLoginAttempt,
  withPasswordLoginAttempt,
} from "#backend/modules/auth/login-rate-limit";
import { hashPassword } from "#backend/modules/auth/password";
import { authenticatePassword } from "#backend/modules/auth/service";
import { setupAuthDatabase } from "#backend-test/support/auth-database";
import { authRateLimitSecret as secret } from "#backend-test/support/auth-test-secrets";

const { admin, connectionString, createVerifiedPasswordLogin, databaseTest } =
  setupAuthDatabase();

databaseTest("password login budgets", () => {
  it("classifies an initially unverified user consistently when the password identity is verified", async () => {
    await migrateDatabase(connectionString!);
    await createVerifiedPasswordLogin(
      "a@example.test",
      "ValidPass1234",
      "setup",
      new Date(),
    );
    await admin!.query("UPDATE users SET email_verified_at = NULL");
    await expect(
      withPasswordLoginAttempt(
        admin!,
        "a@example.test",
        "ip1",
        secret,
        (attempt) =>
          authenticatePassword(
            admin!,
            "a@example.test",
            "ValidPass1234",
            new Date(),
            attempt,
          ),
      ),
    ).resolves.toBeUndefined();
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 1, pending_attempts: [] });
  });

  it("releases without counting failure if user email verification changes after password lookup", async () => {
    await migrateDatabase(connectionString!);
    await createVerifiedPasswordLogin(
      "a@example.test",
      "ValidPass1234",
      "setup",
      new Date(),
    );
    const database = {
      connect: admin!.connect.bind(admin!),
      query: async (sql: string, values?: unknown[]) => {
        const result = await admin!.query(sql, values);
        if (sql.includes("WHERE users.email = $1"))
          await admin!.query("UPDATE users SET email_verified_at = NULL");
        return result;
      },
    } as unknown as Pool;
    await expect(
      withPasswordLoginAttempt(
        database,
        "a@example.test",
        "ip1",
        secret,
        (attempt) =>
          authenticatePassword(
            database,
            "a@example.test",
            "ValidPass1234",
            new Date(),
            attempt,
          ),
      ),
    ).resolves.toBeUndefined();
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 0, pending_attempts: [] });
  });

  it("counts an ineligible password identity consistently even when its password matches", async () => {
    await migrateDatabase(connectionString!);
    await createVerifiedPasswordLogin(
      "a@example.test",
      "ValidPass1234",
      "setup",
      new Date(),
    );
    await admin!.query(
      "UPDATE auth_identities SET activated_at = NULL WHERE provider = 'password'",
    );
    const result = await withPasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
      (attempt) =>
        authenticatePassword(
          admin!,
          "a@example.test",
          "ValidPass1234",
          new Date(),
          attempt,
        ),
    );
    expect(result).toBeUndefined();
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 1, pending_attempts: [] });
  });

  it("does not count or reset failures when the verified password changes before the user lock", async () => {
    await migrateDatabase(connectionString!);
    await createVerifiedPasswordLogin(
      "a@example.test",
      "ValidPass1234",
      "setup",
      new Date(),
    );
    const failed = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    await finishPasswordLoginAttempt(admin!, failed, "failure");
    const replacementHash = await hashPassword("NewValidPass1234");
    const database = {
      connect: admin!.connect.bind(admin!),
      query: async (sql: string, values?: unknown[]) => {
        const result = await admin!.query(sql, values);
        if (sql.includes("WHERE users.email = $1"))
          await admin!.query(
            "UPDATE auth_identities SET password_hash = $1 WHERE provider = 'password'",
            [replacementHash],
          );
        return result;
      },
    } as unknown as Pool;
    const result = await withPasswordLoginAttempt(
      database,
      "a@example.test",
      "ip1",
      secret,
      (attempt) =>
        authenticatePassword(
          database,
          "a@example.test",
          "ValidPass1234",
          new Date(),
          attempt,
        ),
    );
    expect(result).toBeUndefined();
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 1, pending_attempts: [] });
  });
});
