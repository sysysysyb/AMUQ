import type { Pool, PoolClient } from "pg";

export const inTransaction = async <T>(
  database: Pick<Pool, "connect">,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
