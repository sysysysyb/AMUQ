import { databaseUrl } from "#api/db/database";
import { migrateDatabase } from "#api/db/migrations";

await migrateDatabase(databaseUrl());
