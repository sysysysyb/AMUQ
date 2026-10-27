import { createHash } from "node:crypto";

import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import type { GoogleOidcConfig } from "#api/config/environment";
import { createDatabasePool } from "#api/db/database";
import { migrateDatabase } from "#api/db/migrations";
import { buildServer } from "#api/http/server";
import {
  completeGoogleLogin,
  consumeGoogleOidcFlow,
  createGoogleLoginFlow,
} from "#api/modules/auth/service";
import { hashOpaqueToken } from "#api/modules/auth/token";
import {
  authTokenSecret,
  setupAuthDatabase,
} from "#api-test/support/auth-database";

const { admin, connectionString, createVerifiedPasswordLogin, databaseTest } =
  setupAuthDatabase();

databaseTest("Google authentication database and HTTP", () => {
  it("stores hashed Google OIDC requests and consumes each valid state once", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date("2026-10-02T00:00:00.000Z");
    const start = await createGoogleLoginFlow(admin!, "/dashboard", now);
    const stored = await admin!.query<{
      flowHash: string;
      nonceHash: string;
      stateHash: string;
    }>(
      `SELECT flow_hash AS "flowHash",
              state_hash AS "stateHash",
              nonce_hash AS "nonceHash"
         FROM auth_oidc_flows`,
    );

    expect(stored.rows).toMatchObject([
      {
        flowHash: hashOpaqueToken(start.flowToken),
        nonceHash: hashOpaqueToken(start.nonce),
        stateHash: hashOpaqueToken(start.state),
      },
    ]);
    expect(JSON.stringify(stored.rows)).not.toContain(start.flowToken);
    expect(JSON.stringify(stored.rows)).not.toContain(start.state);
    expect(JSON.stringify(stored.rows)).not.toContain(start.nonce);

    await expect(
      consumeGoogleOidcFlow(
        admin!,
        start.flowToken,
        "wrong-state",
        undefined,
        now,
      ),
    ).resolves.toBeUndefined();
    const firstPool = createDatabasePool(connectionString!);
    const secondPool = createDatabasePool(connectionString!);
    const concurrent = await Promise.all([
      consumeGoogleOidcFlow(
        firstPool,
        start.flowToken,
        start.state,
        undefined,
        now,
      ),
      consumeGoogleOidcFlow(
        secondPool,
        start.flowToken,
        start.state,
        undefined,
        now,
      ),
    ]).finally(async () => {
      await Promise.all([firstPool.end(), secondPool.end()]);
    });
    const consumed = concurrent.find(Boolean);
    expect(consumed).toMatchObject({ mode: "login", returnTo: "/dashboard" });
    expect(consumed?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(concurrent.filter(Boolean)).toHaveLength(1);

    const expired = await createGoogleLoginFlow(admin!, "/", now);
    await expect(
      consumeGoogleOidcFlow(
        admin!,
        expired.flowToken,
        expired.state,
        undefined,
        new Date(now.getTime() + 10 * 60 * 1_000),
      ),
    ).resolves.toBeUndefined();
    await createGoogleLoginFlow(
      admin!,
      "/",
      new Date(now.getTime() + 10 * 60 * 1_000),
    );
    const expiredStored = await admin!.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM auth_oidc_flows WHERE flow_hash = $1",
      [hashOpaqueToken(expired.flowToken)],
    );
    expect(expiredStored.rows).toEqual([{ count: "0" }]);
  });

  it("uses Google subject ownership and never auto-links an existing email", async () => {
    await migrateDatabase(connectionString!);
    const now = new Date("2026-10-02T00:00:00.000Z");
    const passwordAccount = await createVerifiedPasswordLogin(
      "password-conflict@example.com",
      "ValidPass1234",
      "203.0.113.80",
      now,
    );
    await expect(
      completeGoogleLogin(
        admin!,
        {
          email: "password-conflict@example.com",
          subject: "must-not-auto-link",
        },
        now,
      ),
    ).resolves.toMatchObject({
      requiredProvider: "password",
      status: "account_link_required",
    });
    const passwordGoogleIdentity = await admin!.query<{
      activatedAt: Date | null;
      count: string;
    }>(
      `SELECT count(*)::text AS count,
              max(activated_at) AS "activatedAt"
         FROM auth_identities
        WHERE user_id = $1 AND provider = 'google'`,
      [passwordAccount.user.id],
    );
    expect(passwordGoogleIdentity.rows).toEqual([
      { activatedAt: null, count: "1" },
    ]);

    const first = await completeGoogleLogin(
      admin!,
      { email: "google@example.com", subject: "google-subject" },
      now,
    );
    expect(first).toMatchObject({
      status: "authenticated",
      user: { email: "google@example.com", emailVerified: true },
    });
    if (first.status !== "authenticated")
      throw new Error("Google login failed");
    const again = await completeGoogleLogin(
      admin!,
      { email: "changed@example.com", subject: "google-subject" },
      now,
    );
    expect(again).toMatchObject({
      status: "authenticated",
      user: { email: "google@example.com", id: first.user.id },
    });
    await expect(
      completeGoogleLogin(
        admin!,
        { email: "google@example.com", subject: "different-subject" },
        now,
      ),
    ).resolves.toEqual({ status: "identity_conflict" });

    const firstPool = createDatabasePool(connectionString!);
    const secondPool = createDatabasePool(connectionString!);
    const concurrent = await Promise.all([
      completeGoogleLogin(
        firstPool,
        { email: "race-google@example.com", subject: "race-subject" },
        now,
      ),
      completeGoogleLogin(
        secondPool,
        { email: "race-google@example.com", subject: "race-subject" },
        now,
      ),
    ]).finally(async () => {
      await Promise.all([firstPool.end(), secondPool.end()]);
    });
    expect(concurrent).toEqual([
      expect.objectContaining({ status: "authenticated" }),
      expect.objectContaining({ status: "authenticated" }),
    ]);
    if (
      concurrent[0].status !== "authenticated" ||
      concurrent[1].status !== "authenticated"
    ) {
      throw new Error("Concurrent Google login failed");
    }
    expect(concurrent[0].user.id).toBe(concurrent[1].user.id);

    const stored = await admin!.query<{ identities: string; users: string }>(
      `SELECT (SELECT count(*)::text FROM users) AS users,
              (SELECT count(*)::text FROM auth_identities) AS identities`,
    );
    expect(stored.rows).toEqual([{ identities: "4", users: "3" }]);
  });

  it("completes and cancels the Google callback without exposing provider data", async () => {
    await migrateDatabase(connectionString!);
    const origin = "https://web.example";
    const googleCodeExchange = vi.fn(
      async (...parameters: [GoogleOidcConfig, string, string, string]) => {
        void parameters;
        return {
          email: "browser-google@example.com",
          subject: "browser-google-subject",
        };
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
      const started = await server.inject({
        method: "POST",
        url: "/auth/google/start",
        headers: { origin },
        payload: { returnTo: "/dashboard?from=google" },
      });
      const flowCookie = String(started.headers["set-cookie"]).split(";")[0]!;
      const authorizationUrl = new URL(started.json().authorizationUrl);
      const secondStart = await server.inject({
        method: "POST",
        url: "/auth/google/start",
        headers: { origin },
        payload: { returnTo: "/second-tab" },
      });
      const secondCookie = String(secondStart.headers["set-cookie"]).split(
        ";",
      )[0]!;
      const firstCookieName = flowCookie.split("=")[0]!;
      const secondCookieName = secondCookie.split("=")[0]!;
      const secondUrl = new URL(secondStart.json().authorizationUrl);
      expect(secondCookieName).not.toBe(firstCookieName);
      const completed = await server.inject({
        method: "GET",
        url: `/auth/google/callback?code=authorization-code&state=${authorizationUrl.searchParams.get("state")}`,
        headers: { cookie: `${flowCookie}; ${secondCookie}` },
      });

      expect(completed.statusCode).toBe(302);
      expect(completed.headers.location).toBe(
        "https://web.example/dashboard?from=google",
      );
      const responseCookies = completed.headers["set-cookie"] as string[];
      expect(responseCookies).toEqual(
        expect.arrayContaining([
          expect.stringContaining("__Host-session="),
          expect.stringContaining(`${firstCookieName}=; Max-Age=0`),
        ]),
      );
      expect(responseCookies).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining(`${secondCookieName}=; Max-Age=0`),
        ]),
      );
      expect(googleCodeExchange).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: "client-id" }),
        "authorization-code",
        expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        expect.stringMatching(/^[0-9a-f]{64}$/),
      );
      const codeVerifier = googleCodeExchange.mock.calls[0]![2];
      expect(
        createHash("sha256").update(codeVerifier, "utf8").digest("base64url"),
      ).toBe(authorizationUrl.searchParams.get("code_challenge"));
      const secondCompleted = await server.inject({
        method: "GET",
        url: `/auth/google/callback?code=second-authorization-code&state=${secondUrl.searchParams.get("state")}`,
        headers: { cookie: secondCookie },
      });
      expect(secondCompleted.statusCode).toBe(302);
      expect(secondCompleted.headers.location).toBe(
        "https://web.example/second-tab",
      );
      expect(secondCompleted.headers["set-cookie"]).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`${secondCookieName}=; Max-Age=0`),
        ]),
      );
      const sessionCookie = responseCookies
        .find((cookie) => cookie.startsWith("__Host-session="))!
        .split(";")[0]!;
      const currentUser = await server.inject({
        method: "GET",
        url: "/account/me",
        headers: { cookie: sessionCookie },
      });
      expect(currentUser.statusCode).toBe(200);
      expect(currentUser.json()).toMatchObject({
        email: "browser-google@example.com",
        emailVerified: true,
      });

      const cancelStart = await server.inject({
        method: "POST",
        url: "/auth/google/start",
        headers: { origin },
        payload: { returnTo: "//evil.example/escape" },
      });
      const cancelCookie = String(cancelStart.headers["set-cookie"]).split(
        ";",
      )[0]!;
      const cancelUrl = new URL(cancelStart.json().authorizationUrl);
      const cancelled = await server.inject({
        method: "GET",
        url: `/auth/google/callback?error=access_denied&state=${cancelUrl.searchParams.get("state")}`,
        headers: { cookie: cancelCookie },
      });
      expect(cancelled.statusCode).toBe(302);
      expect(cancelled.headers.location).toBe(
        "https://web.example/login?authError=provider_cancelled",
      );
      expect(googleCodeExchange).toHaveBeenCalledTimes(2);

      const failedStart = await server.inject({
        method: "POST",
        url: "/auth/google/start",
        headers: { origin },
        payload: { returnTo: "/" },
      });
      const failedCookie = String(failedStart.headers["set-cookie"]).split(
        ";",
      )[0]!;
      const failedUrl = new URL(failedStart.json().authorizationUrl);
      googleCodeExchange.mockRejectedValueOnce(new Error("provider failed"));
      const providerFailed = await server.inject({
        method: "GET",
        url: `/auth/google/callback?code=failed-code&state=${failedUrl.searchParams.get("state")}`,
        headers: { cookie: failedCookie },
      });
      expect(providerFailed.statusCode).toBe(302);
      expect(providerFailed.headers.location).toBe(
        "https://web.example/login?authError=provider_error",
      );
      expect(providerFailed.headers["set-cookie"]).toMatch(
        /__Host-google-oauth-[0-9a-f]{32}=; Max-Age=0/,
      );

      const conflictStart = await server.inject({
        method: "POST",
        url: "/auth/google/start",
        headers: { origin },
        payload: { returnTo: "/dashboard" },
      });
      const conflictCookie = String(conflictStart.headers["set-cookie"]).split(
        ";",
      )[0]!;
      const conflictUrl = new URL(conflictStart.json().authorizationUrl);
      googleCodeExchange.mockResolvedValueOnce({
        email: "browser-google@example.com",
        subject: "conflicting-google-subject",
      });
      const conflicted = await server.inject({
        method: "GET",
        url: `/auth/google/callback?code=conflict-code&state=${conflictUrl.searchParams.get("state")}`,
        headers: { cookie: conflictCookie },
      });
      expect(conflicted.statusCode).toBe(302);
      expect(conflicted.headers.location).toBe(
        "https://web.example/login?authError=identity_conflict",
      );
      expect(conflicted.headers["set-cookie"]).toMatch(
        /__Host-google-oauth-[0-9a-f]{32}=; Max-Age=0/,
      );
      expect(String(conflicted.headers["set-cookie"])).not.toContain(
        "__Host-session=",
      );
    } finally {
      await server.close();
    }
  });

  it("redirects recoverably when Google account completion storage fails", async () => {
    await migrateDatabase(connectionString!);
    const origin = "https://web.example";
    const failingDatabase = {
      query: admin!.query.bind(admin),
      connect: async () => {
        const client = await admin!.connect();
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property === "query") {
              return (queryText: string, values?: unknown[]) => {
                if (queryText.includes("INSERT INTO auth_sessions")) {
                  return Promise.reject(
                    new Error("injected completion failure"),
                  );
                }
                return target.query(queryText, values);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    const server = await buildServer({
      auth: {
        allowedOrigins: [origin],
        authTokenSecret,
        database: failingDatabase,
        googleCodeExchange: vi.fn(async () => ({
          email: "storage-failure@example.com",
          subject: "storage-failure-subject",
        })),
        googleOidc: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://web.example/api/auth/google/callback",
        },
        rateLimitSecret: "r".repeat(32),
        webOrigin: origin,
      },
      environment: "test",
    });

    try {
      const started = await server.inject({
        method: "POST",
        url: "/auth/google/start",
        headers: { origin },
        payload: { returnTo: "/dashboard" },
      });
      const authorizationUrl = new URL(started.json().authorizationUrl);
      const flowCookie = String(started.headers["set-cookie"]).split(";")[0]!;
      const failed = await server.inject({
        method: "GET",
        url: `/auth/google/callback?code=authorization-code&state=${authorizationUrl.searchParams.get("state")}`,
        headers: { cookie: flowCookie },
      });

      expect(failed.statusCode).toBe(302);
      expect(failed.headers.location).toBe(
        "https://web.example/login?authError=service_error",
      );
      expect(failed.headers["set-cookie"]).toMatch(
        /__Host-google-oauth-[0-9a-f]{32}=; Max-Age=0/,
      );
      expect(String(failed.headers["set-cookie"])).not.toContain(
        "__Host-session=",
      );
      const rolledBack = await admin!.query<{
        identities: string;
        sessions: string;
        users: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM users WHERE email = 'storage-failure@example.com') AS users,
           (SELECT count(*)::text FROM auth_identities WHERE provider_subject = 'storage-failure-subject') AS identities,
           (SELECT count(*)::text
              FROM auth_sessions AS session
              JOIN users ON users.id = session.user_id
             WHERE users.email = 'storage-failure@example.com') AS sessions`,
      );
      expect(rolledBack.rows).toEqual([
        { identities: "0", sessions: "0", users: "0" },
      ]);
    } finally {
      await server.close();
    }
  });
});
