import type { Pool } from "pg";
import { afterEach } from "vitest";

import { buildServer } from "#backend/http/server";

export const setupAuthHttpServer = () => {
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

  return createServer;
};
