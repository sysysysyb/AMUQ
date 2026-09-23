import { describe, expect, it } from "vitest";

import {
  createDatabasePool,
  databaseUrl,
  pgBossDatabaseOptions,
} from "./database.js";

describe("database configuration", () => {
  it("requires DATABASE_URL before starting a database process", () => {
    expect(() => databaseUrl({})).toThrow("DATABASE_URL is required");
  });

  it("returns the configured PostgreSQL connection URL", () => {
    expect(databaseUrl({ DATABASE_URL: "postgresql://localhost/amuq" })).toBe(
      "postgresql://localhost/amuq",
    );
  });

  it("bounds database connection and readiness query waits", async () => {
    const pool = createDatabasePool("postgresql://localhost/amuq");

    try {
      expect(pool.options.connectionTimeoutMillis).toBe(5_000);
      expect(pool.options.query_timeout).toBe(5_000);
    } finally {
      await pool.end();
    }
  });

  it("applies the requested timeout to migration queries and lock waits", async () => {
    const pool = createDatabasePool(
      "postgresql://localhost/amuq",
      10 * 60 * 1_000,
    );

    try {
      expect(pool.options.query_timeout).toBe(10 * 60 * 1_000);
      expect(pool.options.options).toBe(
        "-c statement_timeout=600000 -c lock_timeout=600000",
      );
    } finally {
      await pool.end();
    }
  });

  it("bounds pg-boss client and server waits", () => {
    expect(pgBossDatabaseOptions("postgresql://localhost/amuq", 5_000)).toEqual(
      {
        connectionString: "postgresql://localhost/amuq",
        connectionTimeoutMillis: 5_000,
        max: 1,
        options: "-c statement_timeout=5000 -c lock_timeout=5000",
        query_timeout: 5_000,
      },
    );
  });
});
