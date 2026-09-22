import { databaseUrl } from "./database.ts";
import { migrateDatabase } from "./migrations.ts";

await migrateDatabase(databaseUrl());
