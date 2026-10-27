import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "#api/http/server";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];
const database = {} as Pool;

const createServer = async (authDatabase = database) => {
  const server = await buildServer({
    auth: {
      allowedOrigins: ["https://web.example", "http://localhost:3001"],
      authTokenSecret: "a".repeat(32),
      database: authDatabase,
      googleOidc: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://api.example/auth/google/callback",
      },
      rateLimitSecret: "r".repeat(32),
      webOrigin: "https://web.example",
    },
    environment: "test",
  });
  servers.push(server);
  return server;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("authentication HTTP boundary", () => {
  it("enforces the new password policy before signup or reset can touch the database", async () => {
    const query = vi.fn();
    const connect = vi.fn();
    const server = await createServer({ query, connect } as unknown as Pool);
    for (const password of [
      "Abcdef12345", // 11 characters
      "Abcdef123456789012345", // 21 characters
      "lowercase1234",
      "UPPERCASE1234",
      "MixedCaseOnly",
      "😀".repeat(12),
    ]) {
      for (const url of [
        "/auth/signup/complete",
        "/auth/password-reset/confirm",
      ]) {
        const response = await server.inject({
          method: "POST",
          url,
          headers: { origin: "https://web.example" },
          payload: url.endsWith("/complete")
            ? { signupProof: "a".repeat(64), password }
            : { password },
        });
        expect(response.statusCode, `${url}: ${password}`).toBe(400);
        expect(response.json().code).toBe("invalid_request");
      }
    }
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("starts Google authorization with a secure flow cookie", async () => {
    const authDatabase = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;
    const server = await createServer(authDatabase);
    const response = await server.inject({
      method: "POST",
      url: "/auth/google/start",
      headers: { origin: "https://web.example" },
      payload: { returnTo: "https://evil.example/escape" },
    });

    expect(response.statusCode).toBe(200);
    const authorizationUrl = new URL(response.json().authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("state")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(authorizationUrl.searchParams.get("nonce")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(response.headers["set-cookie"]).toMatch(
      /__Host-google-oauth-[0-9a-f]{32}=/,
    );
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(authDatabase.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO auth_oidc_flows"),
      expect.arrayContaining(["login", "/"]),
    );
  });

  it("requires a configured exact Origin and keeps validation errors private", async () => {
    const server = await createServer();
    const body = {
      email: "learner@example.com",
      password: "correct horse battery staple",
    };

    const missing = await server.inject({
      method: "POST",
      url: "/auth/signup/complete",
      payload: body,
    });
    const forged = await server.inject({
      method: "POST",
      url: "/auth/signup/complete",
      headers: { origin: "https://evil.example" },
      payload: body,
    });
    const developmentOrigin = await server.inject({
      method: "POST",
      url: "/auth/signup/complete",
      headers: { origin: "http://localhost:3001" },
      payload: {},
    });

    expect(missing.statusCode).toBe(403);
    expect(forged.statusCode).toBe(403);
    expect(developmentOrigin.statusCode).toBe(400);
    expect(developmentOrigin.json()).toEqual({
      code: "invalid_request",
      message: "요청을 확인해 주세요.",
    });
    const malformed = await server.inject({
      method: "POST",
      url: "/auth/signup/complete",
      headers: {
        "content-type": "application/json",
        origin: "https://web.example",
      },
      payload: "{",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual(developmentOrigin.json());
    for (const response of [missing, forged, developmentOrigin, malformed]) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("rejects duplicate session cookies and expires the browser cookie", async () => {
    const server = await createServer();
    const response = await server.inject({
      method: "GET",
      url: "/account/me",
      headers: {
        cookie: "__Host-session=first; __Host-session=second",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: "authentication_required",
      message: "로그인이 필요합니다.",
    });
    expect(response.headers["set-cookie"]).toContain(
      "__Host-session=; Max-Age=0",
    );
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("requires a valid password-reset session cookie to confirm a reset", async () => {
    const server = await createServer();
    const response = await server.inject({
      method: "POST",
      url: "/auth/password-reset/confirm",
      headers: { origin: "https://web.example" },
      payload: { password: "NewValidPass1234" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "invalid_or_expired_reset_session",
      message: "재설정 시간이 만료되었습니다. 새 링크를 요청해 주세요.",
    });
    expect(response.headers["set-cookie"]).toContain(
      "__Host-password-reset=; Max-Age=0",
    );
  });

  it("revokes the server session and expires the browser cookie on logout", async () => {
    const queries: string[] = [];
    const authDatabase = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
    } as unknown as Pool;
    const server = await createServer(authDatabase);
    const response = await server.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: `__Host-session=${"a".repeat(43)}`,
        origin: "https://web.example",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["set-cookie"]).toContain(
      "__Host-session=; Max-Age=0",
    );
    expect(queries).toEqual([expect.stringContaining("UPDATE auth_sessions")]);
  });

  it("returns a documented Retry-After value when a subject is limited", async () => {
    const client = {
      query: async (sql: string) => ({
        rows: sql.includes("SELECT clock_timestamp()")
          ? [{ now: new Date() }]
          : sql.includes("INSERT INTO auth_password_login_limits")
            ? [
                {
                  windowId: "window",
                  expiresAt: new Date(Date.now() + 60_000),
                  attemptCount: 100,
                  pendingAttempts: [],
                },
              ]
            : sql.includes("SELECT expires_at")
              ? [{ expiresAt: new Date(Date.now() + 60_000) }]
              : [],
      }),
      release: () => undefined,
    };
    const limitedDatabase = {
      connect: async () => client,
    } as unknown as Pool;
    const server = await createServer(limitedDatabase);
    const response = await server.inject({
      method: "POST",
      url: "/auth/signup/challenges",
      headers: { origin: "https://web.example" },
      payload: {
        email: "limited@example.com",
        operationKey: "12345678-1234-4234-8234-123456789012",
      },
    });

    expect(response.statusCode).toBe(429);
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(response.json()).toEqual({
      code: "rate_limit_exceeded",
      message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    });

    const login = await server.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: "https://web.example" },
      payload: {
        email: "limited@example.com",
        password: "ValidPass1234",
      },
    });
    expect(login.statusCode).toBe(429);
    expect(login.headers["retry-after"]).toBeDefined();
  });

  it("does not expose private database errors", async () => {
    const failingDatabase = {
      connect: async () => {
        throw new Error("learner@example.com");
      },
    } as unknown as Pool;
    const server = await createServer(failingDatabase);
    const response = await server.inject({
      method: "POST",
      url: "/auth/signup/challenges",
      headers: { origin: "https://web.example" },
      payload: {
        email: "learner@example.com",
        operationKey: "12345678-1234-4234-8234-123456789012",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: "internal_error",
      message: "요청을 처리하지 못했습니다.",
    });
    expect(response.body).not.toContain("learner@example.com");
  });
});
