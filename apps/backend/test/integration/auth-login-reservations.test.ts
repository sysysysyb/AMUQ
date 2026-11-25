import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { expect, it } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import {
  consumePasswordLoginIp,
  finishPasswordLoginAttempt,
  reservePasswordLoginAttempt,
  withPasswordLoginAttempt,
} from "#backend/modules/auth/login-rate-limit";
import { authenticatePassword } from "#backend/modules/auth/service";
import { setupAuthDatabase } from "#backend-test/support/auth-database";
import { authRateLimitSecret as secret } from "#backend-test/support/auth-test-secrets";

const { admin, connectionString, createVerifiedPasswordLogin, databaseTest } =
  setupAuthDatabase();

databaseTest("password login budgets", () => {
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
