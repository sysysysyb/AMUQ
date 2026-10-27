import { expect, it } from "vitest";

import { migrateDatabase } from "#api/db/migrations";
import { buildServer } from "#api/http/server";
import { issueSession } from "#api/modules/auth/service";
import { deriveAuthToken } from "#api/modules/auth/token";
import {
  authTokenSecret,
  completePasswordSignup,
  setupAuthDatabase,
} from "#api-test/support/auth-database";

const { admin, connectionString, databaseTest } = setupAuthDatabase();

databaseTest("password authentication database and HTTP", () => {
  it("serves the password authentication API without account enumeration", async () => {
    await migrateDatabase(connectionString!);
    const origin = "https://web.example";
    const server = await buildServer({
      auth: {
        allowedOrigins: [origin],
        authTokenSecret,
        database: admin!,
        rateLimitSecret: "r".repeat(32),
        webOrigin: origin,
      },
      environment: "test",
      proxySecret: "proxy-secret",
    });
    const post = (
      url: string,
      payload: Record<string, string>,
      remoteAddress = "203.0.113.40",
    ) =>
      server.inject({
        method: "POST",
        url,
        headers: { origin },
        payload,
        remoteAddress,
      });

    try {
      await completePasswordSignup(
        admin!,
        "api@example.com",
        "ValidPass1234",
        "203.0.113.40",
      );
      const wrong = await post("/auth/login", {
        email: "api@example.com",
        password: "incorrect password value",
      });
      const nonexistent = await post("/auth/login", {
        email: "missing@example.com",
        password: "incorrect password value",
      });
      expect([wrong.statusCode, nonexistent.statusCode]).toEqual([401, 401]);
      expect(wrong.json()).toEqual(nonexistent.json());
      const login = await post("/auth/login", {
        email: "api@example.com",
        password: "ValidPass1234",
      });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers["set-cookie"]);
      expect(cookie).toContain("__Host-session=");
      const current = await server.inject({
        method: "GET",
        url: "/account/me",
        headers: { cookie },
      });
      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject({
        email: "api@example.com",
        emailVerified: true,
      });
      const failedRelogin = await post("/auth/login", {
        email: "api@example.com",
        password: "incorrect password value",
      });
      expect(failedRelogin.statusCode).toBe(401);
      expect(failedRelogin.headers["set-cookie"]).toBeUndefined();
      const otherUser = await admin!.query<{ id: string }>(
        "INSERT INTO users (email, email_verified_at) VALUES ('other@example.com', now()) RETURNING id::text",
      );
      const otherSession = await issueSession(
        admin!,
        otherUser.rows[0]!.id,
        new Date(),
      );
      const otherCurrent = await server.inject({
        method: "GET",
        url: "/account/me",
        headers: { cookie: `__Host-session=${otherSession}` },
      });
      expect(otherCurrent.statusCode).toBe(200);
      expect(otherCurrent.json()).toMatchObject({
        email: "other@example.com",
        emailVerified: true,
      });
      expect(current.json().email).not.toBe(otherCurrent.json().email);

      const existingResetStartedAt = performance.now();
      const existingReset = await post("/auth/password-reset/request", {
        email: "api@example.com",
      });
      const existingResetDuration = performance.now() - existingResetStartedAt;
      const missingResetStartedAt = performance.now();
      const missingReset = await post(
        "/auth/password-reset/request",
        { email: "absent@example.com" },
        "203.0.113.41",
      );
      const missingResetDuration = performance.now() - missingResetStartedAt;
      expect([existingReset.statusCode, missingReset.statusCode]).toEqual([
        202, 202,
      ]);
      expect(existingReset.json()).toEqual(missingReset.json());
      expect(
        Math.min(existingResetDuration, missingResetDuration),
      ).toBeGreaterThanOrEqual(200);

      const reset = await admin!.query<{ id: string }>(
        "SELECT id::text FROM auth_tokens WHERE purpose = 'password_reset' AND consumed_at IS NULL",
      );
      const resetToken = deriveAuthToken(
        "password_reset",
        reset.rows[0]!.id,
        authTokenSecret,
      );
      const exchanged = await post("/auth/password-reset/session", {
        token: resetToken,
      });
      expect(exchanged.statusCode).toBe(200);
      expect(new Date(exchanged.json().expiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
      const resetCookie = String(exchanged.headers["set-cookie"]);
      expect(resetCookie).toContain("__Host-password-reset=");
      expect(resetCookie).toContain("Max-Age=900");
      expect(resetCookie).toContain("SameSite=Strict");
      expect(
        (await post("/auth/password-reset/session", { token: resetToken }))
          .statusCode,
      ).toBe(400);

      const confirmed = await server.inject({
        method: "POST",
        url: "/auth/password-reset/confirm",
        headers: {
          cookie: resetCookie,
          origin: "https://web.example",
        },
        payload: { password: "NewValidPass1234" },
      });
      expect(confirmed.statusCode).toBe(204);
      expect(confirmed.headers["set-cookie"]).toEqual(
        expect.arrayContaining([
          expect.stringContaining("__Host-session=; Max-Age=0"),
          expect.stringContaining("__Host-password-reset=; Max-Age=0"),
        ]),
      );
      const staleSession = await server.inject({
        method: "GET",
        url: "/account/me",
        headers: { cookie },
      });
      expect(staleSession.statusCode).toBe(401);
      expect(staleSession.headers["set-cookie"]).toContain("Max-Age=0");
    } finally {
      await server.close();
    }
  });
});
