import { expect, it, vi } from "vitest";

import { createDatabasePool } from "#api/db/database";
import { migrateDatabase } from "#api/db/migrations";
import {
  authenticatePassword,
  exchangePasswordResetToken,
  getAuthenticatedUser,
  requestPasswordReset,
  resetPassword,
} from "#api/modules/auth/service";
import { deriveAuthToken, hashOpaqueToken } from "#api/modules/auth/token";
import {
  authTokenSecret,
  seedVerifiedPasswordAccount,
  setupAuthDatabase,
} from "#api-test/support/auth-database";

const { admin, connectionString, databaseTest } = setupAuthDatabase();

databaseTest("password reset database", () => {
  it("supersedes pending authentication emails and revokes sessions after reset", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date("2026-09-27T00:00:00.000Z");
    const options = {
      authTokenSecret,
      rateLimitSecret: "r".repeat(32),
    };
    await seedVerifiedPasswordAccount(
      admin!,
      "reset@example.com",
      "old password with enough length",
      now,
    );
    const login = await authenticatePassword(
      admin!,
      "reset@example.com",
      "old password with enough length",
      now,
    );
    if (!login || login.status !== "authenticated") {
      throw new Error("Password login failed");
    }

    await requestPasswordReset(
      admin!,
      "reset@example.com",
      "203.0.113.3",
      options,
      now,
    );
    await requestPasswordReset(
      admin!,
      "reset@example.com",
      "203.0.113.4",
      options,
      new Date(now.getTime() + 1),
    );
    const resetTokens = await admin!.query<{
      consumedAt: Date | null;
      id: string;
      status: string;
    }>(
      `SELECT token.id::text,
              token.consumed_at AS "consumedAt",
              outbox.status
         FROM auth_tokens AS token
         JOIN email_outbox AS outbox ON outbox.token_id = token.id
        WHERE token.purpose = 'password_reset'
        ORDER BY token.created_at, token.id`,
    );
    expect(resetTokens.rows).toHaveLength(2);
    expect(resetTokens.rows[0]).toMatchObject({ status: "failed" });
    expect(resetTokens.rows[0]!.consumedAt).not.toBeNull();
    expect(resetTokens.rows[1]).toMatchObject({
      consumedAt: null,
      status: "pending",
    });

    const resetRawToken = deriveAuthToken(
      "password_reset",
      resetTokens.rows[1]!.id,
      authTokenSecret,
    );
    const resetSession = await exchangePasswordResetToken(
      admin!,
      resetRawToken,
      () => new Date(now.getTime() + 2),
    );
    expect(resetSession).toBeDefined();
    const resetPool = createDatabasePool(connectionString!);
    const loginPool = createDatabasePool(connectionString!);
    const [resetResult, racingLogin] = await Promise.all([
      resetPassword(
        resetPool,
        resetSession!.rawToken,
        "new password with enough length",
        () => new Date(now.getTime() + 3),
      ),
      authenticatePassword(
        loginPool,
        "reset@example.com",
        "old password with enough length",
        new Date(now.getTime() + 2),
      ),
    ]).finally(async () => {
      await Promise.all([resetPool.end(), loginPool.end()]);
    });
    expect(resetResult).toBe(true);
    if (racingLogin?.status === "authenticated") {
      await expect(
        getAuthenticatedUser(
          admin!,
          racingLogin.sessionToken,
          new Date(now.getTime() + 3),
        ),
      ).resolves.toBeUndefined();
    }
    await expect(
      resetPassword(
        admin!,
        resetSession!.rawToken,
        "another password with enough length",
        () => new Date(now.getTime() + 4),
      ),
    ).resolves.toBe(false);
    await expect(
      getAuthenticatedUser(
        admin!,
        login.sessionToken,
        new Date(now.getTime() + 4),
      ),
    ).resolves.toBeUndefined();
    await expect(
      authenticatePassword(
        admin!,
        "reset@example.com",
        "new password with enough length",
        new Date(now.getTime() + 4),
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a reset token that expires while the replacement password is hashed", async () => {
    await migrateDatabase(connectionString!);
    const issuedAt = new Date("2026-09-27T00:00:00.000Z");
    const options = {
      authTokenSecret,
      rateLimitSecret: "r".repeat(32),
    };
    await seedVerifiedPasswordAccount(
      admin!,
      "expiring-reset@example.com",
      "old password with enough length",
      issuedAt,
    );
    await requestPasswordReset(
      admin!,
      "expiring-reset@example.com",
      "203.0.113.5",
      options,
      issuedAt,
    );
    const resetLink = await admin!.query<{ id: string }>(
      "SELECT id::text FROM auth_tokens WHERE purpose = 'password_reset'",
    );
    const resetSession = await exchangePasswordResetToken(
      admin!,
      deriveAuthToken("password_reset", resetLink.rows[0]!.id, authTokenSecret),
      () => issuedAt,
    );
    expect(resetSession).toBeDefined();
    const resetToken = await admin!.query<{
      expiresAt: Date;
      id: string;
      passwordHash: string;
    }>(
      `SELECT token.id::text,
              token.expires_at AS "expiresAt",
              identity.password_hash AS "passwordHash"
         FROM auth_tokens AS token
         JOIN auth_identities AS identity ON identity.user_id = token.user_id
         WHERE token.purpose = 'password_reset_session'`,
    );
    const token = resetToken.rows[0]!;
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date(token.expiresAt.getTime() - 1))
      .mockReturnValueOnce(token.expiresAt);

    await expect(
      resetPassword(
        admin!,
        resetSession!.rawToken,
        "new password with enough length",
        clock,
      ),
    ).resolves.toBe(false);

    expect(clock).toHaveBeenCalledTimes(2);
    const stored = await admin!.query<{
      consumedAt: Date | null;
      passwordHash: string;
    }>(
      `SELECT token.consumed_at AS "consumedAt",
              identity.password_hash AS "passwordHash"
         FROM auth_tokens AS token
         JOIN auth_identities AS identity ON identity.user_id = token.user_id
        WHERE token.id = $1`,
      [token.id],
    );
    expect(stored.rows).toEqual([
      { consumedAt: null, passwordHash: token.passwordHash },
    ]);
  });

  it("does not consume a reset link that expires while waiting for its user lock", async () => {
    await migrateDatabase(connectionString!);
    const issuedAt = new Date("2026-09-27T00:00:00.000Z");
    const resetLink = await createVerifiedResetLink(
      "expiring-link@example.com",
      "203.0.113.51",
      issuedAt,
    );
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date(resetLink.expiresAt.getTime() - 1))
      .mockReturnValueOnce(resetLink.expiresAt);

    await expect(
      exchangePasswordResetToken(admin!, resetLink.rawToken, clock),
    ).resolves.toBeUndefined();

    const stored = await admin!.query<{
      consumedAt: Date | null;
      resetSessions: string;
    }>(
      `SELECT link.consumed_at AS "consumedAt",
              count(session.id)::text AS "resetSessions"
         FROM auth_tokens AS link
         LEFT JOIN auth_tokens AS session
           ON session.user_id = link.user_id
          AND session.purpose = 'password_reset_session'
        WHERE link.id = $1
        GROUP BY link.consumed_at`,
      [resetLink.id],
    );
    expect(stored.rows).toEqual([{ consumedAt: null, resetSessions: "0" }]);
  });

  it("exchanges a reset link only once under concurrent requests", async () => {
    await migrateDatabase(connectionString!);
    const issuedAt = new Date("2026-09-27T00:00:00.000Z");
    const resetLink = await createVerifiedResetLink(
      "concurrent-link@example.com",
      "203.0.113.52",
      issuedAt,
    );
    const firstPool = createDatabasePool(connectionString!);
    const secondPool = createDatabasePool(connectionString!);

    const results = await Promise.all([
      exchangePasswordResetToken(firstPool, resetLink.rawToken, () => issuedAt),
      exchangePasswordResetToken(
        secondPool,
        resetLink.rawToken,
        () => issuedAt,
      ),
    ]).finally(async () => {
      await Promise.all([firstPool.end(), secondPool.end()]);
    });

    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await admin!.query<{
      consumedAt: Date | null;
      resetSessions: string;
    }>(
      `SELECT link.consumed_at AS "consumedAt",
              count(session.id)::text AS "resetSessions"
         FROM auth_tokens AS link
         LEFT JOIN auth_tokens AS session
           ON session.user_id = link.user_id
          AND session.purpose = 'password_reset_session'
        WHERE link.id = $1
        GROUP BY link.consumed_at`,
      [resetLink.id],
    );
    expect(stored.rows[0]!.consumedAt).not.toBeNull();
    expect(stored.rows[0]!.resetSessions).toBe("1");
  });

  it("invalidates an existing reset session when a new reset is requested", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date("2026-09-27T00:00:00.000Z");
    const options = {
      authTokenSecret,
      rateLimitSecret: "r".repeat(32),
    };
    await seedVerifiedPasswordAccount(
      admin!,
      "reissued-reset@example.com",
      "old password with enough length",
      now,
    );
    await requestPasswordReset(
      admin!,
      "reissued-reset@example.com",
      "203.0.113.6",
      options,
      now,
    );
    const reset = await admin!.query<{ id: string }>(
      "SELECT id::text FROM auth_tokens WHERE purpose = 'password_reset' AND consumed_at IS NULL",
    );
    const session = await exchangePasswordResetToken(
      admin!,
      deriveAuthToken("password_reset", reset.rows[0]!.id, authTokenSecret),
      () => new Date(now.getTime() + 1),
    );
    expect(session).toBeDefined();

    await requestPasswordReset(
      admin!,
      "reissued-reset@example.com",
      "203.0.113.7",
      options,
      new Date(now.getTime() + 2),
    );

    await expect(
      resetPassword(
        admin!,
        session!.rawToken,
        "new password with enough length",
        () => new Date(now.getTime() + 3),
      ),
    ).resolves.toBe(false);
    const stored = await admin!.query<{ tokenHash: string }>(
      `SELECT token_hash AS "tokenHash"
         FROM auth_tokens
        WHERE purpose = 'password_reset_session'`,
    );
    expect(stored.rows).toEqual([
      { tokenHash: hashOpaqueToken(session!.rawToken) },
    ]);
    expect(stored.rows[0]!.tokenHash).not.toBe(session!.rawToken);
  });
});

const createVerifiedResetLink = async (
  email: string,
  clientAddress: string,
  issuedAt: Date,
) => {
  const options = {
    authTokenSecret,
    rateLimitSecret: "r".repeat(32),
  };
  await seedVerifiedPasswordAccount(
    admin!,
    email,
    "old password with enough length",
    issuedAt,
  );
  await requestPasswordReset(admin!, email, clientAddress, options, issuedAt);
  const resetLink = await admin!.query<{ expiresAt: Date; id: string }>(
    `SELECT id::text, expires_at AS "expiresAt"
       FROM auth_tokens
      WHERE purpose = 'password_reset'`,
  );
  return {
    ...resetLink.rows[0]!,
    rawToken: deriveAuthToken(
      "password_reset",
      resetLink.rows[0]!.id,
      authTokenSecret,
    ),
  };
};
