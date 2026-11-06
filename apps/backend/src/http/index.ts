import {
  applicationEnvironment,
  authApiConfig,
  googleOidcConfig,
  proxySharedSecret,
  resendWebhookSecret,
} from "#backend/config/environment";
import {
  assertDatabaseSchema,
  createDatabasePool,
  databaseUrl,
} from "#backend/db/database";
import { buildServer, registerShutdownHandlers } from "#backend/http/server";
import { retireLegacySignupTokens } from "#backend/modules/auth/service";

const environment = applicationEnvironment();
const auth = authApiConfig();
const googleOidc = googleOidcConfig();
const proxySecret = proxySharedSecret();
const webhookSecret = resendWebhookSecret();
const connectionString = databaseUrl();
const pool = createDatabasePool(connectionString);

try {
  await assertDatabaseSchema(connectionString, pool);
  await retireLegacySignupTokens(pool);
} catch (error) {
  await pool.end();
  throw error;
}

const server = await buildServer({
  auth: { ...auth, database: pool, ...(googleOidc ? { googleOidc } : {}) },
  environment,
  ...(webhookSecret
    ? { emailWebhook: { database: pool, secret: webhookSecret } }
    : {}),
  onClose: async () => pool.end(),
  readiness: async () => {
    await pool.query("SELECT 1");
  },
  ...(proxySecret ? { proxySecret } : {}),
});
registerShutdownHandlers(server);

await server.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3001),
});
