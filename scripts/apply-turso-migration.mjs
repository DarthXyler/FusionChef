import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createClient } from "@libsql/client";

const migrationArgument = process.argv[2]?.trim() ?? "";
if (!migrationArgument) {
  throw new Error(
    "Usage: node scripts/apply-turso-migration.mjs migrations/<migration>.sql",
  );
}

const migrationsDirectory = path.resolve(process.cwd(), "migrations");
const migrationPath = path.resolve(process.cwd(), migrationArgument);
const relativeMigrationPath = path.relative(
  migrationsDirectory,
  migrationPath,
);
if (
  relativeMigrationPath.startsWith("..") ||
  path.isAbsolute(relativeMigrationPath) ||
  path.extname(migrationPath).toLowerCase() !== ".sql"
) {
  throw new Error("Migration must be a .sql file inside the migrations directory.");
}

const databaseUrl = process.env.TURSO_DATABASE_URL?.trim() ?? "";
const authToken = process.env.TURSO_AUTH_TOKEN?.trim() ?? "";
if (!databaseUrl || !authToken) {
  throw new Error(
    "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be configured.",
  );
}

const migrationSql = await readFile(migrationPath, "utf8");
const client = createClient({
  url: databaseUrl,
  authToken,
});

try {
  await client.executeMultiple(migrationSql);
  console.info(`Applied migration: ${relativeMigrationPath}`);
} finally {
  client.close();
}
