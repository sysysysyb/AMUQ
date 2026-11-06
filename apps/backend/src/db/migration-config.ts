import { fileURLToPath } from "node:url";

export const migrationConfig = {
  migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  migrationsSchema: "drizzle",
  migrationsTable: "__drizzle_migrations",
} as const;
