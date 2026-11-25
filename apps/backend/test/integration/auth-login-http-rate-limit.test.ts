import { expect, it } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import {
  consumePasswordLoginIp,
  hashPasswordLoginSubject,
  reservePasswordLoginAttempt,
} from "#backend/modules/auth/login-rate-limit";
import { setupPasswordLoginHttp } from "#backend-test/support/auth-login-rate-limit";
import { authRateLimitSecret as secret } from "#backend-test/support/auth-test-secrets";

const {
  admin,
  connectionString,
  createVerifiedPasswordLogin,
  createServer,
  databaseTest,
} = setupPasswordLoginHttp();

databaseTest("password login budgets", () => {
  it("keeps the last login admission available after rejected-origin requests", async () => {
    await migrateDatabase(connectionString!);
    await createVerifiedPasswordLogin(
      "a@example.test",
      "ValidPass1234",
      "setup",
      new Date(),
    );
    const clientAddress = "192.0.2.9";
    const subjectHash = hashPasswordLoginSubject(
      "client_address",
      [clientAddress],
      secret,
    );
    await consumePasswordLoginIp(admin!, clientAddress, secret);
    await admin!.query(
      "UPDATE auth_password_login_limits SET attempt_count = 99 WHERE subject_kind = 'client_address' AND subject_hash = $1",
      [subjectHash],
    );
    const server = await createServer();
    try {
      for (const url of ["/auth/login", "/auth/link/password"]) {
        for (const origin of [undefined, "null", "https://evil.example"]) {
          const rejected = await server.inject({
            method: "POST",
            url,
            remoteAddress: clientAddress,
            headers: origin === undefined ? {} : { origin },
            payload: { email: "a@example.test", password: "ValidPass1234" },
          });
          expect(rejected.statusCode).toBe(403);
          expect(rejected.json().code).toBe("origin_not_allowed");
        }
      }
      const counter = () =>
        admin!.query(
          "SELECT attempt_count FROM auth_password_login_limits WHERE subject_kind = 'client_address' AND subject_hash = $1",
          [subjectHash],
        );
      expect((await counter()).rows).toEqual([{ attempt_count: 99 }]);
      const accepted = await server.inject({
        method: "POST",
        url: "/auth/login",
        remoteAddress: clientAddress,
        headers: { origin: "http://localhost:3000" },
        payload: { email: "a@example.test", password: "ValidPass1234" },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.headers["set-cookie"]).toContain("__Host-session=");
      expect((await counter()).rows).toEqual([{ attempt_count: 100 }]);
    } finally {
      await server.close();
    }
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

  it("counts malformed and invalid-link requests from allowed Origins, sharing only the two POST routes", async () => {
    await migrateDatabase(connectionString!);
    const server = await createServer();
    try {
      const rejectedOrigin = await server.inject({
        method: "POST",
        url: "/auth/login?test=1",
        headers: {
          "content-type": "application/json",
          origin: "https://invalid.test",
        },
        payload: "{",
      });
      expect(rejectedOrigin.statusCode).toBe(403);
      expect(rejectedOrigin.json().code).toBe("origin_not_allowed");
      const malformed = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        payload: "{",
      });
      expect(malformed.statusCode).toBe(400);
      const invalidLink = await server.inject({
        method: "POST",
        url: "/auth/link/password",
        headers: { origin: "http://localhost:3000" },
        payload: { consent: true, password: "ValidPass1234" },
      });
      expect(invalidLink.statusCode).toBe(401);
      expect(invalidLink.json().code).toBe("account_link_required");
      await server.inject({ method: "GET", url: "/auth/session" });
      const rows = await admin!.query(
        "SELECT subject_kind, attempt_count FROM auth_password_login_limits",
      );
      expect(rows.rows).toEqual([
        { subject_kind: "client_address", attempt_count: 2 },
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
});
