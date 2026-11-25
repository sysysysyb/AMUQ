import { buildServer } from "#backend/http/server";
import { setupAuthDatabase } from "#backend-test/support/auth-database";
import {
  authRateLimitSecret,
  authTokenSecret,
} from "#backend-test/support/auth-test-secrets";

export const setupPasswordLoginHttp = () => {
  const { admin, connectionString, databaseTest, createVerifiedPasswordLogin } =
    setupAuthDatabase();

  const createServer = () =>
    buildServer({
      environment: "test",
      auth: {
        database: admin!,
        allowedOrigins: ["http://localhost:3000"],
        authTokenSecret,
        rateLimitSecret: authRateLimitSecret,
        webOrigin: "http://localhost:3000",
      },
    });

  return {
    admin,
    connectionString,
    databaseTest,
    createVerifiedPasswordLogin,
    createServer,
  };
};
