import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { expect, it } from "vitest";

import { migrateDatabase } from "#api/db/migrations";
import { buildServer } from "#api/http/server";
import {
  consumePasswordLoginIp,
  finishPasswordLoginAttempt,
  hashPasswordLoginSubject,
  reservePasswordLoginAttempt,
  withPasswordLoginAttempt,
} from "#api/modules/auth/login-rate-limit";
import { hashPassword } from "#api/modules/auth/password";
import {
  authenticatePassword,
  completeAccountLinkWithPassword,
  completeGoogleLogin,
} from "#api/modules/auth/service";
import { setupAuthDatabase } from "#api-test/support/auth-database";

const { admin, connectionString, createVerifiedPasswordLogin, databaseTest } =
  setupAuthDatabase();
const secret = "r".repeat(32);
const createServer = () =>
  buildServer({
    environment: "test",
    auth: {
      database: admin!,
      allowedOrigins: ["http://localhost:3000"],
      authTokenSecret: "a".repeat(32),
      rateLimitSecret: secret,
      webOrigin: "http://localhost:3000",
    },
  });

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
  it("rejects a successful completion if a live reservation row unexpectedly disappears", async () => {
    await migrateDatabase(connectionString!);
    const attempt = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    await admin!.query("DELETE FROM auth_password_login_limits");
    await expect(
      finishPasswordLoginAttempt(admin!, attempt, "success"),
    ).rejects.toThrow("reservation");
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

  it("lets a valid admitted login finish after its window expires without changing the next window", async () => {
    await migrateDatabase(connectionString!);
    await createVerifiedPasswordLogin(
      "a@example.test",
      "ValidPass1234",
      "setup",
      new Date(),
    );
    let nextAttemptId: string | undefined;
    const database = {
      connect: admin!.connect.bind(admin!),
      query: async (sql: string, values?: unknown[]) => {
        const result = await admin!.query(sql, values);
        if (sql.includes("WHERE users.email = $1")) {
          await admin!.query(
            "UPDATE auth_password_login_limits SET window_started_at = clock_timestamp() - interval '16 minutes', expires_at = clock_timestamp() - interval '1 minute'",
          );
          nextAttemptId = (
            await reservePasswordLoginAttempt(
              admin!,
              "a@example.test",
              "ip1",
              secret,
            )
          ).attemptId;
        }
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
          { ...attempt, expiresAt: new Date(0) },
        ),
    );
    expect(result?.status).toBe("authenticated");
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 0, pending_attempts: [nextAttemptId] });
  });

  it("does not globally lock the email after another IP exhausts its pair", async () => {
    await migrateDatabase(connectionString!);
    await createVerifiedPasswordLogin(
      "a@example.test",
      "ValidPass1234",
      "setup",
      new Date(),
    );
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
      const response = await server.inject({
        method: "POST",
        url: "/auth/login",
        remoteAddress: "127.0.0.2",
        headers: { origin: "http://localhost:3000" },
        payload: { email: "a@example.test", password: "ValidPass1234" },
      });
      expect(response.statusCode).toBe(200);
      expect(
        (
          await admin!.query(
            "SELECT attempt_count FROM auth_password_login_limits WHERE subject_hash = $1",
            [
              hashPasswordLoginSubject(
                "identifier_client_address",
                ["a@example.test", "127.0.0.1"],
                secret,
              ),
            ],
          )
        ).rows[0].attempt_count,
      ).toBe(10);
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
  it("uses post-lock database time when an admission waits across expiry", async () => {
    await migrateDatabase(connectionString!);
    const initial = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    const pool = new Pool({ connectionString, max: 1 });
    const blocker = await pool.connect();
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiter = new Pool({ connectionString, max: 1 });
    const database = {
      connect: async () => {
        const client = await waiter.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query")
              return (sql: string, values?: unknown[]) => {
                const result = target.query(sql, values);
                if (sql.includes("INSERT INTO auth_password_login_limits"))
                  entered();
                return result;
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM auth_password_login_limits FOR UPDATE",
      );
      const waiting = reservePasswordLoginAttempt(
        database,
        "a@example.test",
        "ip1",
        secret,
      );
      await reached;
      await blocker.query(
        "UPDATE auth_password_login_limits SET window_started_at = clock_timestamp() - interval '16 minutes', expires_at = clock_timestamp(), attempt_count = 9",
      );
      await blocker.query("COMMIT");
      const next = await waiting;
      expect(next.windowId).not.toBe(initial.windowId);
      expect(
        (
          await admin!.query(
            "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
          )
        ).rows[0],
      ).toEqual({ attempt_count: 0, pending_attempts: [next.attemptId] });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.all([pool.end(), waiter.end()]);
    }
  });

  it("normalizes the pair and commits the IP count even when the pair is blocked", async () => {
    await migrateDatabase(connectionString!);
    const hash = hashPasswordLoginSubject(
      "identifier_client_address",
      ["a@example.test", "127.0.0.1"],
      secret,
    );
    await admin!.query(
      `INSERT INTO auth_password_login_limits (subject_kind, subject_hash, window_started_at, expires_at, attempt_count)
      VALUES ('identifier_client_address', $1, clock_timestamp(), clock_timestamp() + interval '15 minutes', 10)`,
      [hash],
    );
    await expect(
      reservePasswordLoginAttempt(
        admin!,
        " A@EXAMPLE.TEST ",
        "127.0.0.1",
        secret,
      ),
    ).rejects.toThrow();
    const server = await createServer();
    try {
      const response = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin: "http://localhost:3000" },
        payload: { email: "a@example.test", password: "ValidPass1234" },
      });
      expect(response.statusCode).toBe(429);
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(
        (
          await admin!.query(
            "SELECT attempt_count FROM auth_password_login_limits WHERE subject_kind = 'client_address'",
          )
        ).rows[0].attempt_count,
      ).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("releases on verifier errors and aborts without resetting existing failures", async () => {
    await migrateDatabase(connectionString!);
    const failed = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    await finishPasswordLoginAttempt(admin!, failed, "failure");
    await expect(
      withPasswordLoginAttempt(
        admin!,
        "a@example.test",
        "ip1",
        secret,
        async () => {
          throw new Error("verification failure");
        },
      ),
    ).rejects.toThrow("verification failure");
    await withPasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
      async () => ({ status: "invalid_session" }),
    );
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 1, pending_attempts: [] });
  });
  it("admits only one concurrent last pair slot and the last IP request across independent connections", async () => {
    await migrateDatabase(connectionString!);
    const pool = new Pool({ connectionString, max: 4 });
    try {
      for (let i = 0; i < 9; i++)
        await finishPasswordLoginAttempt(
          pool,
          await reservePasswordLoginAttempt(
            pool,
            "a@example.test",
            "ip1",
            secret,
          ),
          "failure",
        );
      const pairs = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          reservePasswordLoginAttempt(pool, "a@example.test", "ip1", secret),
        ),
      );
      expect(
        pairs.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      for (let i = 0; i < 99; i++)
        await consumePasswordLoginIp(pool, "ip1", secret);
      const ips = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          consumePasswordLoginIp(pool, "ip1", secret),
        ),
      );
      expect(
        ips.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("applies success resets in completion order without cancelling other reservations", async () => {
    await migrateDatabase(connectionString!);
    const a = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    const b = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    await finishPasswordLoginAttempt(admin!, a, "success");
    const c = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    await finishPasswordLoginAttempt(admin!, c, "failure");
    expect(
      (
        await admin!.query(
          "SELECT attempt_count FROM auth_password_login_limits",
        )
      ).rows[0].attempt_count,
    ).toBe(1);
    await finishPasswordLoginAttempt(admin!, b, "success");
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 0, pending_attempts: [] });
  });

  it("rolls back success reset when session insertion fails, then releases only its reservation", async () => {
    await migrateDatabase(connectionString!);
    await createVerifiedPasswordLogin(
      "a@example.test",
      "ValidPass1234",
      "setup",
      new Date(),
    );
    const previous = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    await finishPasswordLoginAttempt(admin!, previous, "failure");
    const other = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    const sessions = (
      await admin!.query("SELECT count(*)::int AS count FROM auth_sessions")
    ).rows;
    const database = {
      query: admin!.query.bind(admin!),
      connect: async () => {
        const client = await admin!.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query")
              return async (sql: string, values?: unknown[]) => {
                if (sql.includes("INSERT INTO auth_sessions"))
                  throw new Error("session insertion failed");
                return target.query(sql, values);
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
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
    ).rejects.toThrow("session insertion failed");
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 1, pending_attempts: [other.attemptId] });
    expect(
      (await admin!.query("SELECT count(*)::int AS count FROM auth_sessions"))
        .rows,
    ).toEqual(sessions);
  });

  it("cleans at most 128 expired rows and leaves locked expired rows alone", async () => {
    await migrateDatabase(connectionString!);
    await admin!
      .query(`INSERT INTO auth_password_login_limits (subject_kind, subject_hash, window_started_at, expires_at)
      SELECT 'client_address', lpad(to_hex(n), 64, '0'), clock_timestamp() - interval '16 minutes', clock_timestamp() - interval '1 minute' FROM generate_series(1, 130) AS n`);
    const pool = new Pool({ connectionString, max: 1 });
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM auth_password_login_limits WHERE subject_hash = lpad('1', 64, '0') FOR UPDATE",
      );
      await consumePasswordLoginIp(admin!, "ip1", secret);
      expect(
        (
          await admin!.query(
            "SELECT count(*)::int AS count FROM auth_password_login_limits WHERE expires_at < clock_timestamp()",
          )
        ).rows[0].count,
      ).toBe(2);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pool.end();
    }
  });

  it.each([
    ["client_address", 101, "'{}'::uuid[]"],
    ["client_address", 0, "ARRAY[gen_random_uuid()]"],
    ["identifier_client_address", 10, "ARRAY[gen_random_uuid()]"],
    ["identifier_client_address", -1, "'{}'::uuid[]"],
    ["identifier_client_address", 0, "ARRAY[NULL]::uuid[]"],
    ["identifier_client_address", 0, "ARRAY[ARRAY[gen_random_uuid()]]"],
  ])(
    "rejects invalid persisted budget: %s / %s / %s",
    async (kind, count, pending) => {
      await migrateDatabase(connectionString!);
      await expect(
        admin!.query(
          `INSERT INTO auth_password_login_limits (subject_kind, subject_hash, window_started_at, expires_at, attempt_count, pending_attempts)
      VALUES ($1, repeat('a', 64), clock_timestamp(), clock_timestamp() + interval '15 minutes', $2, ${pending})`,
          [kind, count],
        ),
      ).rejects.toThrow();
    },
  );
  it("counts malformed, rejected-origin and invalid-link requests before validation, sharing only the two POST routes", async () => {
    await migrateDatabase(connectionString!);
    const server = await createServer();
    try {
      await server.inject({
        method: "POST",
        url: "/auth/login?test=1",
        headers: {
          "content-type": "application/json",
          origin: "https://invalid.test",
        },
        payload: "{",
      });
      await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        payload: "{",
      });
      await server.inject({
        method: "POST",
        url: "/auth/link/password",
        headers: { origin: "http://localhost:3000" },
        payload: { consent: true, password: "ValidPass1234" },
      });
      await server.inject({ method: "GET", url: "/auth/session" });
      const rows = await admin!.query(
        "SELECT subject_kind, attempt_count FROM auth_password_login_limits",
      );
      expect(rows.rows).toEqual([
        { subject_kind: "client_address", attempt_count: 3 },
      ]);
    } finally {
      await server.close();
    }
  });

  it("counts credential failures per email and IP, resets on success, and preserves the IP budget", async () => {
    await migrateDatabase(connectionString!);
    await createVerifiedPasswordLogin(
      "a@example.test",
      "ValidPass1234",
      "ip-setup",
      new Date(),
    );
    const server = await createServer();
    const login = (password: string) =>
      server.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin: "http://localhost:3000" },
        payload: { email: "a@example.test", password },
      });
    try {
      expect((await login("WrongPass1234")).statusCode).toBe(401);
      expect((await login("ValidPass1234")).statusCode).toBe(200);
      expect(
        (
          await admin!.query(
            "SELECT attempt_count, pending_attempts FROM auth_password_login_limits WHERE subject_kind = 'identifier_client_address'",
          )
        ).rows,
      ).toEqual([{ attempt_count: 0, pending_attempts: [] }]);
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
  it("reserves the last pair slot atomically and preserves other pending attempts on success", async () => {
    await migrateDatabase(connectionString!);
    const reserve = () =>
      reservePasswordLoginAttempt(admin!, "a@example.test", "ip1", secret);
    for (let i = 0; i < 8; i++) {
      const attempt = await reserve();
      await finishPasswordLoginAttempt(admin!, attempt, "failure");
    }
    const a = await reserve();
    const b = await reserve();
    await expect(reserve()).rejects.toMatchObject({
      retryAfterSeconds: expect.any(Number),
    });
    await finishPasswordLoginAttempt(admin!, a, "success");
    const state = await admin!.query(
      "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
    );
    expect(state.rows[0]).toMatchObject({
      attempt_count: 0,
      pending_attempts: [b.attemptId],
    });
    await finishPasswordLoginAttempt(admin!, b, "failure");
    await finishPasswordLoginAttempt(admin!, b, "failure");
    expect(
      (
        await admin!.query(
          "SELECT attempt_count FROM auth_password_login_limits",
        )
      ).rows[0].attempt_count,
    ).toBe(1);
    await expect(
      reservePasswordLoginAttempt(admin!, "a@example.test", "ip2", secret),
    ).resolves.toBeDefined();
  });

  it("shares IP requests across pairs, admits exactly 100, and leaves expiry fixed when blocked", async () => {
    await migrateDatabase(connectionString!);
    await consumePasswordLoginIp(admin!, "ip1", secret);
    const initial = (
      await admin!.query("SELECT expires_at FROM auth_password_login_limits")
    ).rows[0];
    for (let i = 1; i < 100; i++)
      await consumePasswordLoginIp(admin!, "ip1", secret);
    await expect(
      consumePasswordLoginIp(admin!, "ip1", secret),
    ).rejects.toMatchObject({ retryAfterSeconds: expect.any(Number) });
    expect(
      (
        await admin!.query(
          "SELECT attempt_count, expires_at FROM auth_password_login_limits",
        )
      ).rows[0],
    ).toEqual({ attempt_count: 100, expires_at: initial.expires_at });
  });

  it("fences expired-window completions and resets an expired key without cleanup", async () => {
    await migrateDatabase(connectionString!);
    const old = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    await admin!.query(
      "UPDATE auth_password_login_limits SET window_started_at = clock_timestamp() - interval '16 minutes', expires_at = clock_timestamp() - interval '1 minute'",
    );
    const current = await reservePasswordLoginAttempt(
      admin!,
      "a@example.test",
      "ip1",
      secret,
    );
    expect(current.windowId).not.toBe(old.windowId);
    const expired = { ...old, expiresAt: new Date(0) };
    await finishPasswordLoginAttempt(admin!, expired, "failure");
    await finishPasswordLoginAttempt(admin!, expired, "success");
    const state = (
      await admin!.query(
        "SELECT attempt_count, pending_attempts FROM auth_password_login_limits",
      )
    ).rows[0];
    expect(state).toEqual({
      attempt_count: 0,
      pending_attempts: [current.attemptId],
    });
    await expect(
      finishPasswordLoginAttempt(
        admin!,
        { ...current, attemptId: randomUUID() },
        "success",
      ),
    ).rejects.toThrow();
  });
});
