import process from "node:process";
import { createClient } from "@libsql/client";

const databaseUrl = process.env.TURSO_DATABASE_URL?.trim() ?? "";
const authToken = process.env.TURSO_AUTH_TOKEN?.trim() ?? "";
if (!databaseUrl || !authToken) {
  throw new Error(
    "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be configured.",
  );
}

const client = createClient({
  url: databaseUrl,
  authToken,
});

try {
  const result = await client.execute(
    "SELECT * FROM purchase_ledger_backfill_report",
  );
  const row = result.rows[0] ?? {};
  console.info(
    JSON.stringify({
      expectedLinked: Number(row.expected_linked_count ?? 0),
      linked: Number(row.linked_count ?? 0),
      skipped: Number(row.skipped_count ?? 0),
      ambiguous: Number(row.ambiguous_count ?? 0),
    }),
  );
} finally {
  client.close();
}
