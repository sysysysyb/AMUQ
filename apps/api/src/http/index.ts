import {
  assertDatabaseSchema,
  createDatabasePool,
  databaseUrl,
} from "../db/database.ts";
import { buildServer, registerShutdownHandlers } from "./server.ts";

const connectionString = databaseUrl();
const pool = createDatabasePool(connectionString);

try {
  await assertDatabaseSchema(connectionString, pool);
} catch (error) {
  await pool.end();
  throw error;
}

const server = await buildServer({
  environment: process.argv.includes("--development")
    ? "development"
    : "production",
  onClose: async () => pool.end(),
  readiness: async () => {
    await pool.query("SELECT 1");
  },
});
registerShutdownHandlers(server);

await server.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3001),
});
