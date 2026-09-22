import {
  assertDatabaseSchema,
  createDatabasePool,
  databaseUrl,
} from "./database.ts";

const connectionString = databaseUrl();
const pool = createDatabasePool(connectionString);

try {
  await assertDatabaseSchema(connectionString, pool);
} finally {
  await pool.end();
}
