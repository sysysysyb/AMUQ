import { describe, expect, it } from "vitest";

import { assertTestDatabaseUrl } from "./test-database.js";

describe("test database safety", () => {
  it("accepts the dedicated disposable database", () => {
    expect(
      assertTestDatabaseUrl(
        "postgresql://postgres:postgres@localhost/amuq_test",
      ),
    ).toBe("postgresql://postgres:postgres@localhost/amuq_test");
  });

  it("rejects a non-test database before destructive cleanup", () => {
    expect(() =>
      assertTestDatabaseUrl("postgresql://postgres:postgres@localhost/amuq"),
    ).toThrow('TEST_DATABASE_URL must target the "amuq_test" database');
  });

  it.each([
    "postgres:amuq_test",
    "https://localhost/amuq_test",
    "not a database URL",
  ])("rejects an unsafe connection string: %s", (connectionString) => {
    expect(() => assertTestDatabaseUrl(connectionString)).toThrow(
      'TEST_DATABASE_URL must target the "amuq_test" database',
    );
  });
});
