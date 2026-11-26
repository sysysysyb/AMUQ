import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { setupAuthHttpServer } from "#backend-test/support/auth-http-server";

const createServer = setupAuthHttpServer();

describe("authentication HTTP boundary", () => {
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
});
