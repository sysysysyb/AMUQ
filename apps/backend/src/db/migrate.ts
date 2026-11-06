import { databaseUrl } from "#backend/db/database";
import { migrateDatabase } from "#backend/db/migrations";

await migrateDatabase(databaseUrl());
