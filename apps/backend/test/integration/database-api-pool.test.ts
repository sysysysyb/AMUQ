import { expect, it } from "vitest";

import { createDatabasePool } from "#backend/db/database";
import { createTestDatabase } from "#backend-test/support/database-fixture";

const { connectionString, databaseTest } = createTestDatabase("suite");

databaseTest("database deployment", () => {
  it("bounds the wait when the API database pool is exhausted", async () => {
    const pool = createDatabasePool(connectionString!);
    const client = await pool.connect();

    try {
      await expect(pool.query("SELECT 1")).rejects.toThrow(
        "timeout exceeded when trying to connect",
      );
    } finally {
      client.release();
      await pool.end();
    }
  }, 10_000);
});
