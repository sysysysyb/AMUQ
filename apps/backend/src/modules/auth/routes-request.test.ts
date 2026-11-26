import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { setupAuthHttpServer } from "#backend-test/support/auth-http-server";

const createServer = setupAuthHttpServer();

describe("authentication HTTP boundary", () => {
  it.each(["/auth/login", "/auth/link/password"])(
    "rejects untrusted Origins before touching login budgets on %s",
    async (url) => {
      const query = vi.fn();
      const connect = vi.fn();
      const server = await createServer({ query, connect } as unknown as Pool);
      for (const origin of [
        undefined,
        "null",
        "https://evil.example",
        "https://web.example.evil.example",
      ]) {
        const response = await server.inject({
          method: "POST",
          url,
          headers: origin === undefined ? {} : { origin },
          payload: { email: "learner@example.com", password: "ValidPass1234" },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe("origin_not_allowed");
      }
      expect(query).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    },
  );

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

  it("accepts the new password boundaries without restricting legacy login passwords", async () => {
    const server = await createServer();
    for (const password of [
      "ValidPass123",
      "ValidPass12345678901",
      "Ab1" + "😀".repeat(9),
    ]) {
      const response = await server.inject({
        method: "POST",
        url: "/auth/password-reset/confirm",
        headers: { origin: "https://web.example" },
        payload: { password },
      });
      expect(response.json().code).toBe("invalid_or_expired_reset_session");
    }
    const document = (
      await server.inject({ method: "GET", url: "/openapi.json" })
    ).json();
    const passwordSchema = (path: string) =>
      document.paths[path].post.requestBody.content["application/json"].schema
        .properties.password;
    expect(passwordSchema("/auth/signup/complete")).toMatchObject({
      minLength: 12,
      maxLength: 20,
      pattern: expect.any(String),
    });
    expect(passwordSchema("/auth/password-reset/confirm")).toEqual(
      passwordSchema("/auth/signup/complete"),
    );
    expect(passwordSchema("/auth/login")).toMatchObject({
      minLength: 12,
      maxLength: 128,
    });
    expect(passwordSchema("/auth/login")).not.toHaveProperty("pattern");
    expect(passwordSchema("/auth/link/password")).not.toHaveProperty("pattern");
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
