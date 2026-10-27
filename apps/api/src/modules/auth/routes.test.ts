import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
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
