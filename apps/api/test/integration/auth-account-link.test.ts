import { expect, it, vi } from "vitest";

import type { GoogleOidcConfig } from "#api/config/environment";
import { createDatabasePool } from "#api/db/database";
import { migrateDatabase } from "#api/db/migrations";
import { buildServer } from "#api/http/server";
import {
  authenticatePassword,
  completeAccountLinkWithPassword,
  completeGoogleLink,
  completeGoogleLogin,
  consumeGoogleOidcFlow,
  createGoogleLinkFlow,
  getAccountLinkStatus,
} from "#api/modules/auth/service";
import { hashOpaqueToken } from "#api/modules/auth/token";
import {
  authTokenSecret,
  completePasswordSignup,
  setupAuthDatabase,
} from "#api-test/support/auth-database";

const { admin, connectionString, createVerifiedPasswordLogin, databaseTest } =
  setupAuthDatabase();

databaseTest("account linking database and HTTP", () => {
  it("links both authentication directions only after the second proven identity", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date("2026-10-04T00:00:00.000Z");
    const password = "ValidPass1234";

    const passwordAccount = await createVerifiedPasswordLogin(
      "password-first@example.com",
      password,
      "203.0.113.90",
      now,
    );
    const sessionsBeforeGoogle = await sessionCount(passwordAccount.user.id);
    const googlePrimary = await completeGoogleLogin(
      admin!,
      {
        email: "password-first@example.com",
        subject: "password-first-google",
      },
      now,
    );
    expect(googlePrimary).toMatchObject({
      requiredProvider: "password",
      status: "account_link_required",
    });
    if (googlePrimary.status !== "account_link_required") {
      throw new Error("Google collision did not require password proof");
    }
    expect(await sessionCount(passwordAccount.user.id)).toBe(
      sessionsBeforeGoogle,
    );
    await expect(
      getAccountLinkStatus(admin!, googlePrimary.linkSessionToken, now),
    ).resolves.toEqual({
      email: "password-first@example.com",
      requiredProvider: "password",
    });
    const storedGoogleLink = await admin!.query<{
      activatedAt: Date | null;
      tokenHash: string;
    }>(
      `SELECT identity.activated_at AS "activatedAt",
              link.token_hash AS "tokenHash"
         FROM auth_link_sessions AS link
         JOIN auth_identities AS identity
           ON identity.user_id = link.user_id AND identity.provider = 'google'
        WHERE link.user_id = $1`,
      [passwordAccount.user.id],
    );
    expect(storedGoogleLink.rows).toEqual([
      {
        activatedAt: null,
        tokenHash: hashOpaqueToken(googlePrimary.linkSessionToken),
      },
    ]);
    expect(JSON.stringify(storedGoogleLink.rows)).not.toContain(
      googlePrimary.linkSessionToken,
    );
    await expect(
      completeAccountLinkWithPassword(
        admin!,
        googlePrimary.linkSessionToken,
        "wrong password value",
        true,
        now,
      ),
    ).resolves.toEqual({ status: "invalid_credentials" });

    const firstPool = createDatabasePool(connectionString!);
    const secondPool = createDatabasePool(connectionString!);
    const passwordProofs = await Promise.all([
      completeAccountLinkWithPassword(
        firstPool,
        googlePrimary.linkSessionToken,
        password,
        true,
        now,
      ),
      completeAccountLinkWithPassword(
        secondPool,
        googlePrimary.linkSessionToken,
        password,
        true,
        now,
      ),
    ]).finally(async () => {
      await Promise.all([firstPool.end(), secondPool.end()]);
    });
    expect(
      passwordProofs.filter(({ status }) => status === "authenticated"),
    ).toHaveLength(1);
    expect(passwordProofs).toContainEqual({ status: "invalid_session" });
    await expect(
      getAccountLinkStatus(admin!, googlePrimary.linkSessionToken, now),
    ).resolves.toBeUndefined();
    await expect(
      authenticatePassword(admin!, passwordAccount.user.email, password, now),
    ).resolves.toMatchObject({ status: "authenticated" });
    await expect(
      completeGoogleLogin(
        admin!,
        {
          email: passwordAccount.user.email,
          subject: "password-first-google",
        },
        now,
      ),
    ).resolves.toMatchObject({ status: "authenticated" });

    const googleAccount = await completeGoogleLogin(
      admin!,
      { email: "google-first@example.com", subject: "google-first-subject" },
      now,
    );
    if (googleAccount.status !== "authenticated") {
      throw new Error("Google account setup failed");
    }
    await completePasswordSignup(
      admin!,
      "google-first@example.com",
      password,
      "203.0.113.91",
      { authTokenSecret, rateLimitSecret: "r".repeat(32) },
      now,
    );
    const sessionsBeforePassword = await sessionCount(googleAccount.user.id);
    const passwordPrimary = await authenticatePassword(
      admin!,
      "google-first@example.com",
      password,
      now,
    );
    expect(passwordPrimary).toMatchObject({
      requiredProvider: "google",
      status: "account_link_required",
    });
    if (passwordPrimary?.status !== "account_link_required") {
      throw new Error("Password collision did not require Google proof");
    }
    expect(await sessionCount(googleAccount.user.id)).toBe(
      sessionsBeforePassword,
    );
    await expect(
      completeAccountLinkWithPassword(
        admin!,
        passwordPrimary.linkSessionToken,
        password,
        true,
        now,
      ),
    ).resolves.toEqual({ status: "invalid_session" });

    const wrongFlowStart = await createGoogleLinkFlow(
      admin!,
      passwordPrimary.linkSessionToken,
      "/dashboard",
      now,
    );
    const wrongFlow = await consumeGoogleOidcFlow(
      admin!,
      wrongFlowStart!.flowToken,
      wrongFlowStart!.state,
      passwordPrimary.linkSessionToken,
      now,
    );
    await expect(
      completeGoogleLink(
        admin!,
        wrongFlow!,
        { email: "google-first@example.com", subject: "wrong-subject" },
        now,
      ),
    ).resolves.toEqual({ status: "identity_conflict" });
    await expect(
      getAccountLinkStatus(admin!, passwordPrimary.linkSessionToken, now),
    ).resolves.toEqual({
      email: "google-first@example.com",
      requiredProvider: "google",
    });

    const correctFlowStart = await createGoogleLinkFlow(
      admin!,
      passwordPrimary.linkSessionToken,
      "/dashboard",
      now,
    );
    const correctFlow = await consumeGoogleOidcFlow(
      admin!,
      correctFlowStart!.flowToken,
      correctFlowStart!.state,
      passwordPrimary.linkSessionToken,
      now,
    );
    const linked = await completeGoogleLink(
      admin!,
      correctFlow!,
      {
        email: "google-first@example.com",
        subject: "google-first-subject",
      },
      now,
    );
    expect(linked).toMatchObject({
      status: "authenticated",
      user: { id: googleAccount.user.id },
    });
    await expect(
      authenticatePassword(admin!, googleAccount.user.email, password, now),
    ).resolves.toMatchObject({ status: "authenticated" });
    await expect(
      completeGoogleLogin(
        admin!,
        {
          email: googleAccount.user.email,
          subject: "google-first-subject",
        },
        now,
      ),
    ).resolves.toMatchObject({ status: "authenticated" });
    const activatedProviders = await admin!.query<{
      activated: boolean;
      provider: string;
    }>(
      `SELECT activated_at IS NOT NULL AS activated, provider
         FROM auth_identities
        WHERE user_id = $1
        ORDER BY provider::text`,
      [googleAccount.user.id],
    );
    expect(activatedProviders.rows).toEqual([
      { activated: true, provider: "google" },
      { activated: true, provider: "password" },
    ]);
    await expect(
      completeGoogleLink(
        admin!,
        correctFlow!,
        {
          email: "google-first@example.com",
          subject: "google-first-subject",
        },
        now,
      ),
    ).resolves.toEqual({ status: "invalid_session" });

    const expiringAccount = await createVerifiedPasswordLogin(
      "expiring-link@example.com",
      password,
      "203.0.113.92",
      now,
    );
    const expiringLink = await completeGoogleLogin(
      admin!,
      {
        email: "expiring-link@example.com",
        subject: "expiring-google-subject",
      },
      now,
    );
    if (expiringLink.status !== "account_link_required") {
      throw new Error("Expiring collision setup failed");
    }
    const expiredAt = new Date(now.getTime() + 10 * 60 * 1_000);
    await expect(
      getAccountLinkStatus(admin!, expiringLink.linkSessionToken, expiredAt),
    ).resolves.toBeUndefined();
    await expect(
      completeAccountLinkWithPassword(
        admin!,
        expiringLink.linkSessionToken,
        password,
        true,
        expiredAt,
      ),
    ).resolves.toEqual({ status: "invalid_session" });
    expect(
      await admin!.query(
        "SELECT count(*)::int AS count FROM users WHERE email = $1",
        [expiringAccount.user.email],
      ),
    ).toMatchObject({ rows: [{ count: 1 }] });
  }, 20_000);

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

const sessionCount = async (userId: string) => {
  const result = await admin!.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM auth_sessions WHERE user_id = $1",
    [userId],
  );
  return result.rows[0]!.count;
};

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
