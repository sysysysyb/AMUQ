import {
  applicationEnvironment,
  proxySharedSecret,
} from "#api/config/environment";
import {
  assertDatabaseSchema,
  createDatabasePool,
  databaseUrl,
} from "#api/db/database";
import { buildServer, registerShutdownHandlers } from "./server.ts";

const environment = applicationEnvironment();
const proxySecret = proxySharedSecret();
const connectionString = databaseUrl();
const pool = createDatabasePool(connectionString);

try {
  await assertDatabaseSchema(connectionString, pool);
} catch (error) {
  await pool.end();
  throw error;
}

const server = await buildServer({
  environment,
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
