import {
  assertDatabaseSchema,
  createDatabasePool,
  databaseUrl,
} from "#api/db/database";

const connectionString = databaseUrl();
const pool = createDatabasePool(connectionString);

try {
  await assertDatabaseSchema(connectionString, pool);
} finally {
  await pool.end();
}
