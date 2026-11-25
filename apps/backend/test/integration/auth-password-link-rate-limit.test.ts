import { Pool } from "pg";
import { expect, it } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import {
  finishPasswordLoginAttempt,
  hashPasswordLoginSubject,
  reservePasswordLoginAttempt,
  withPasswordLoginAttempt,
} from "#backend/modules/auth/login-rate-limit";
import {
  authenticatePassword,
  completeAccountLinkWithPassword,
  completeGoogleLogin,
} from "#backend/modules/auth/service";
import { setupPasswordLoginHttp } from "#backend-test/support/auth-login-rate-limit";
import { authRateLimitSecret as secret } from "#backend-test/support/auth-test-secrets";

const {
  admin,
  connectionString,
  createVerifiedPasswordLogin,
  createServer,
  databaseTest,
} = setupPasswordLoginHttp();

const createPasswordLinkFixture = async () => {
  await createVerifiedPasswordLogin(
    "a@example.test",
    "ValidPass1234",
    "setup",
    new Date(),
  );
  const link = await completeGoogleLogin(admin!, {
    email: "a@example.test",
    subject: "password-link-verification",
  });
  if (
    link.status !== "account_link_required" ||
    link.requiredProvider !== "password"
  )
    throw new Error("Missing password-link fixture");
  return link.linkSessionToken;
};

databaseTest("password login budgets", () => {
  it("rejects an unverified link owner before pair admission for either password", async () => {
    await migrateDatabase(connectionString!);
    const token = await createPasswordLinkFixture();
    await admin!.query("UPDATE users SET email_verified_at = NULL");
    const server = await createServer();
    try {
      for (const password of ["WrongPass1234", "ValidPass1234"]) {
        const result = await server.inject({
          method: "POST",
          url: "/auth/link/password",
          headers: {
            origin: "http://localhost:3000",
            cookie: `__Host-account-link=${token}`,
          },
          payload: { consent: true, password },
        });
        expect(result.statusCode).toBe(401);
        expect(result.json().code).toBe("account_link_required");
      }
      expect(
        (
          await admin!.query(
            "SELECT attempt_count FROM auth_password_login_limits WHERE subject_kind = 'identifier_client_address'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await admin!.query(
            "SELECT attempt_count FROM auth_password_login_limits WHERE subject_kind = 'client_address'",
          )
        ).rows,
      ).toEqual([{ attempt_count: 2 }]);
    } finally {
      await server.close();
    }
  });

  it("does not distinguish passwords when a link candidate owner is already unverified", async () => {
    await migrateDatabase(connectionString!);
    const token = await createPasswordLinkFixture();
    await admin!.query("UPDATE users SET email_verified_at = NULL");
    for (const password of ["ValidPass1234", "WrongPass1234"]) {
      const result = await withPasswordLoginAttempt(
        admin!,
        "a@example.test",
        "ip1",
        secret,
        (attempt) =>
          completeAccountLinkWithPassword(
            admin!,
            token,
            password,
            true,
            () => new Date(),
            attempt,
          ),
      );
      expect(result.status).toBe("invalid_session");
    }
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 0, pending_attempts: [] });
  });

  it("does not activate or consume a link if owner verification changes after candidate lookup", async () => {
    await migrateDatabase(connectionString!);
    const token = await createPasswordLinkFixture();
    const database = {
      connect: admin!.connect.bind(admin!),
      query: async (sql: string, values?: unknown[]) => {
        const result = await admin!.query(sql, values);
        if (sql.includes("FROM auth_link_sessions AS link"))
          await admin!.query("UPDATE users SET email_verified_at = NULL");
        return result;
      },
    } as unknown as Pool;
    const result = await withPasswordLoginAttempt(
      database,
      "a@example.test",
      "ip1",
      secret,
      (attempt) =>
        completeAccountLinkWithPassword(
          database,
          token,
          "ValidPass1234",
          true,
          () => new Date(),
          attempt,
        ),
    );
    expect(result.status).toBe("invalid_session");
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 0, pending_attempts: [] });
    expect(
      (
        await admin!.query(
          "SELECT activated_at FROM auth_identities WHERE provider = 'google'",
        )
      ).rows[0].activated_at,
    ).toBeNull();
    expect(
      (await admin!.query("SELECT consumed_at FROM auth_link_sessions")).rows[0]
        .consumed_at,
    ).toBeNull();
  });

  it.each([false, true])(
    "rejects Google-proof link cookies before password admission (full pair: %s)",
    async (full) => {
      await migrateDatabase(connectionString!);
      await createVerifiedPasswordLogin(
        "a@example.test",
        "ValidPass1234",
        "setup",
        new Date(),
      );
      await completeGoogleLogin(admin!, {
        email: "a@example.test",
        subject: "google-proof-direction",
      });
      await admin!.query(
        "UPDATE auth_identities SET activated_at = CASE WHEN provider = 'google' THEN clock_timestamp() ELSE NULL END",
      );
      const link = await authenticatePassword(
        admin!,
        "a@example.test",
        "ValidPass1234",
      );
      if (
        link?.status !== "account_link_required" ||
        link.requiredProvider !== "google"
      )
        throw new Error("Missing Google-proof fixture");
      if (full)
        await admin!.query(
          `INSERT INTO auth_password_login_limits (subject_kind, subject_hash, window_started_at, expires_at, attempt_count)
      VALUES ('identifier_client_address', $1, clock_timestamp(), clock_timestamp() + interval '15 minutes', 10)`,
          [
            hashPasswordLoginSubject(
              "identifier_client_address",
              ["a@example.test", "127.0.0.1"],
              secret,
            ),
          ],
        );
      const server = await createServer();
      try {
        const result = await server.inject({
          method: "POST",
          url: "/auth/link/password",
          headers: {
            origin: "http://localhost:3000",
            cookie: `__Host-account-link=${link.linkSessionToken}`,
          },
          payload: { consent: true, password: "ValidPass1234" },
        });
        expect(result.statusCode).toBe(401);
        expect(result.json().code).toBe("account_link_required");
        expect(
          (
            await admin!.query(
              "SELECT attempt_count, pending_attempts FROM auth_password_login_limits WHERE subject_kind = 'identifier_client_address'",
            )
          ).rows,
        ).toEqual(full ? [{ attempt_count: 10, pending_attempts: [] }] : []);
        expect(
          (
            await admin!.query(
              "SELECT attempt_count FROM auth_password_login_limits WHERE subject_kind = 'client_address'",
            )
          ).rows,
        ).toEqual([{ attempt_count: 1 }]);
      } finally {
        await server.close();
      }
    },
  );

  it("shares a single pair budget when alternating login and password linking, including a renewed link cookie", async () => {
    await migrateDatabase(connectionString!);
    await createVerifiedPasswordLogin(
      "a@example.test",
      "ValidPass1234",
      "setup",
      new Date(),
    );
    const identity = {
      email: "a@example.test",
      subject: "alternating-password-proof",
    };
    const link = await completeGoogleLogin(admin!, identity);
    if (link.status !== "account_link_required")
      throw new Error("Missing link fixture");
    const server = await createServer();
    const login = () =>
      server.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin: "http://localhost:3000" },
        payload: { email: "A@EXAMPLE.TEST", password: "WrongPass1234" },
      });
    const passwordLink = (token: string) =>
      server.inject({
        method: "POST",
        url: "/auth/link/password",
        headers: {
          origin: "http://localhost:3000",
          cookie: `__Host-account-link=${token}`,
        },
        payload: { consent: true, password: "WrongPass1234" },
      });
    try {
      expect((await login()).statusCode).toBe(401);
      expect((await passwordLink(link.linkSessionToken)).statusCode).toBe(401);
      expect(
        (
          await admin!.query(
            "SELECT attempt_count FROM auth_password_login_limits WHERE subject_kind = 'identifier_client_address'",
          )
        ).rows,
      ).toEqual([{ attempt_count: 2 }]);
      await admin!.query(
        "UPDATE auth_password_login_limits SET attempt_count = 10 WHERE subject_kind = 'identifier_client_address'",
      );
      const renewed = await completeGoogleLogin(admin!, identity);
      if (renewed.status !== "account_link_required")
        throw new Error("Missing renewed link fixture");
      expect((await login()).statusCode).toBe(429);
      expect((await passwordLink(renewed.linkSessionToken)).statusCode).toBe(
        429,
      );
      expect(
        (
          await admin!.query(
            "SELECT attempt_count FROM auth_password_login_limits WHERE subject_kind = 'client_address'",
          )
        ).rows,
      ).toEqual([{ attempt_count: 4 }]);
    } finally {
      await server.close();
    }
  });

  it("does not link or reset failures if the link expires while waiting for quota completion", async () => {
    await migrateDatabase(connectionString!);
    await createVerifiedPasswordLogin(
      "a@example.test",
      "ValidPass1234",
      "setup",
      new Date(),
    );
    const link = await completeGoogleLogin(admin!, {
      email: "a@example.test",
      subject: "quota-expiry-google",
    });
    if (link.status !== "account_link_required")
      throw new Error("Missing link fixture");
    const failed = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    await finishPasswordLoginAttempt(admin!, failed, "failure");
    const database = {
      query: admin!.query.bind(admin!),
      connect: async () => {
        const client = await admin!.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query")
              return async (sql: string, values?: unknown[]) => {
                if (
                  sql.includes("FROM auth_password_login_limits WHERE") &&
                  sql.includes("FOR UPDATE")
                ) {
                  await target.query(
                    "UPDATE auth_link_sessions SET created_at = clock_timestamp() - interval '11 minutes', expires_at = clock_timestamp() - interval '1 second'",
                  );
                }
                return target.query(sql, values);
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    const result = await withPasswordLoginAttempt(
      database,
      "a@example.test",
      "ip1",
      secret,
      (attempt) =>
        completeAccountLinkWithPassword(
          database,
          link.linkSessionToken,
          "ValidPass1234",
          true,
          () => new Date(),
          attempt,
        ),
    );
    expect(result?.status).toBe("invalid_session");
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 1, pending_attempts: [] });
    expect(
      (
        await admin!.query(
          "SELECT activated_at FROM auth_identities WHERE provider = 'google'",
        )
      ).rows[0].activated_at,
    ).toBeNull();
  });
});
