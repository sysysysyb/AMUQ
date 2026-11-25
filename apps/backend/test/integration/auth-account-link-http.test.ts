import { expect, it, vi } from "vitest";

import type { GoogleOidcConfig } from "#backend/config/environment";
import { migrateDatabase } from "#backend/db/migrations";
import { buildServer } from "#backend/http/server";
import { completeGoogleLogin } from "#backend/modules/auth/service";
import {
  authTokenSecret,
  completePasswordSignup,
  setupAuthDatabase,
} from "#backend-test/support/auth-database";

const { admin, connectionString, createVerifiedPasswordLogin, databaseTest } =
  setupAuthDatabase();

const cookiePair = (
  header: string | string[] | undefined,
  prefix: string,
): string => {
  const cookies = Array.isArray(header) ? header : [header ?? ""];
  const cookie = cookies
    .flatMap((value) => value.split(/,(?=__Host-)/))
    .map((value) => value.split(";")[0]!)
    .find((value) => value.startsWith(prefix));
  if (!cookie) throw new Error(`Missing cookie: ${prefix}`);
  return cookie;
};

databaseTest("account linking database and HTTP", () => {
  it("exposes the restricted account-link flow through the HTTP boundary", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date();
    const origin = "https://web.example";
    const password = "ValidPass1234";
    await createVerifiedPasswordLogin(
      "http-password-first@example.com",
      password,
      "203.0.113.93",
      now,
    );
    const googleAccount = await completeGoogleLogin(
      admin!,
      { email: "http-google-first@example.com", subject: "http-google-first" },
      now,
    );
    if (googleAccount.status !== "authenticated") {
      throw new Error("Google account setup failed");
    }
    await completePasswordSignup(
      admin!,
      "http-google-first@example.com",
      password,
      "203.0.113.94",
      { authTokenSecret, rateLimitSecret: "r".repeat(32) },
      now,
    );

    const googleCodeExchange = vi.fn(
      async (_config: GoogleOidcConfig, code: string) =>
        code === "password-first-code"
          ? {
              email: "http-password-first@example.com",
              subject: "http-password-first-google",
            }
          : {
              email: "http-google-first@example.com",
              subject: "http-google-first",
            },
    );
    const server = await buildServer({
      auth: {
        allowedOrigins: [origin],
        authTokenSecret,
        database: admin!,
        googleCodeExchange,
        googleOidc: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://api.example/auth/google/callback",
        },
        rateLimitSecret: "r".repeat(32),
        webOrigin: origin,
      },
      environment: "test",
    });

    try {
      const googleStart = await server.inject({
        method: "POST",
        url: "/auth/google/start",
        headers: { origin },
        payload: {},
      });
      const googleAuthorization = new URL(googleStart.json().authorizationUrl);
      const googleFlowCookie = cookiePair(
        googleStart.headers["set-cookie"],
        "__Host-google-oauth-",
      );
      const googleCollision = await server.inject({
        method: "GET",
        url: `/auth/google/callback?code=password-first-code&state=${googleAuthorization.searchParams.get("state")}`,
        headers: { cookie: googleFlowCookie },
      });
      expect(googleCollision.statusCode).toBe(302);
      expect(googleCollision.headers.location).toBe(
        "https://web.example/login/link",
      );
      const passwordRequiredCookie = cookiePair(
        googleCollision.headers["set-cookie"],
        "__Host-account-link=",
      );
      const passwordStatus = await server.inject({
        method: "GET",
        url: "/auth/link/status",
        headers: { cookie: passwordRequiredCookie },
      });
      expect(passwordStatus.json()).toEqual({
        email: "http-password-first@example.com",
        requiredProvider: "password",
      });
      const wrongPassword = await server.inject({
        method: "POST",
        url: "/auth/link/password",
        headers: { cookie: passwordRequiredCookie, origin },
        payload: { consent: true, password: "wrong password value" },
      });
      expect(wrongPassword.statusCode).toBe(401);
      expect(wrongPassword.json()).toEqual({
        code: "invalid_credentials",
        message: "비밀번호를 확인해 주세요.",
      });
      expect(wrongPassword.headers["set-cookie"]).toBeUndefined();

      const renewedGoogleLink = await completeGoogleLogin(
        admin!,
        {
          email: "http-password-first@example.com",
          subject: "http-password-first-google",
        },
        now,
      );
      if (renewedGoogleLink.status !== "account_link_required") {
        throw new Error(
          "Renewed Google collision did not require password proof",
        );
      }
      const renewedLinkCookie = `__Host-account-link=${renewedGoogleLink.linkSessionToken}`;
      const renewedWrongPassword = await server.inject({
        method: "POST",
        url: "/auth/link/password",
        headers: { cookie: renewedLinkCookie, origin },
        payload: { consent: true, password: "another wrong password" },
      });
      expect(renewedWrongPassword.statusCode).toBe(401);
      const identifierLimits = await admin!.query<{ attemptCount: number }>(
        `SELECT attempt_count AS "attemptCount"
           FROM auth_password_login_limits
          WHERE subject_kind = 'identifier_client_address' AND attempt_count > 0`,
      );
      expect(identifierLimits.rows).toEqual([{ attemptCount: 2 }]);

      const passwordLink = await server.inject({
        method: "POST",
        url: "/auth/link/password",
        headers: { cookie: renewedLinkCookie, origin },
        payload: { consent: true, password },
      });
      expect(passwordLink.statusCode).toBe(200);
      expect(passwordLink.json()).toMatchObject({
        email: "http-password-first@example.com",
      });
      expect(String(passwordLink.headers["set-cookie"])).toContain(
        "__Host-session=",
      );
      expect(String(passwordLink.headers["set-cookie"])).toContain(
        "__Host-account-link=;",
      );

      const passwordLogin = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin },
        payload: { email: "http-google-first@example.com", password },
      });
      expect(passwordLogin.statusCode).toBe(200);
      expect(passwordLogin.json()).toEqual({
        requiredProvider: "google",
        status: "account_link_required",
      });
      const googleRequiredCookie = cookiePair(
        passwordLogin.headers["set-cookie"],
        "__Host-account-link=",
      );
      const secondaryStart = await server.inject({
        method: "POST",
        url: "/auth/link/google",
        headers: { cookie: googleRequiredCookie, origin },
        payload: { returnTo: "/dashboard" },
      });
      expect(secondaryStart.statusCode).toBe(200);
      const secondaryAuthorization = new URL(
        secondaryStart.json().authorizationUrl,
      );
      const secondaryFlowCookie = cookiePair(
        secondaryStart.headers["set-cookie"],
        "__Host-google-oauth-",
      );
      const cancelled = await server.inject({
        method: "GET",
        url: `/auth/google/callback?error=access_denied&state=${secondaryAuthorization.searchParams.get("state")}`,
        headers: {
          cookie: `${googleRequiredCookie}; ${secondaryFlowCookie}`,
        },
      });
      expect(cancelled.statusCode).toBe(302);
      expect(cancelled.headers.location).toBe(
        "https://web.example/login/link?authError=provider_cancelled",
      );

      const secondaryRetry = await server.inject({
        method: "POST",
        url: "/auth/link/google",
        headers: { cookie: googleRequiredCookie, origin },
        payload: { returnTo: "/dashboard" },
      });
      const retryAuthorization = new URL(
        secondaryRetry.json().authorizationUrl,
      );
      const retryFlowCookie = cookiePair(
        secondaryRetry.headers["set-cookie"],
        "__Host-google-oauth-",
      );
      const completed = await server.inject({
        method: "GET",
        url: `/auth/google/callback?code=google-first-code&state=${retryAuthorization.searchParams.get("state")}`,
        headers: {
          cookie: `${googleRequiredCookie}; ${retryFlowCookie}`,
        },
      });
      expect(completed.statusCode).toBe(302);
      expect(completed.headers.location).toBe("https://web.example/dashboard");
      expect(String(completed.headers["set-cookie"])).toContain(
        "__Host-session=",
      );
      expect(String(completed.headers["set-cookie"])).toContain(
        "__Host-account-link=;",
      );
    } finally {
      await server.close();
    }
  }, 20_000);
});
