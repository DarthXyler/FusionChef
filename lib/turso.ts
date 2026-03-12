/**
 * Turso client access + query timeout wrapper.
 * Central place for DB connectivity and defensive query timeout handling.
 */
import { createClient, type InStatement } from "@libsql/client";

let cachedClient: ReturnType<typeof createClient> | null = null;
const DEFAULT_TURSO_QUERY_TIMEOUT_MS = 8_000;

function getTursoQueryTimeoutMs() {
  // Optional env override with safe bounds.
  const raw = Number.parseInt(process.env.TURSO_QUERY_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(raw) || raw < 1_000 || raw > 60_000) {
    return DEFAULT_TURSO_QUERY_TIMEOUT_MS;
  }
  return raw;
}

export function getTursoClient() {
  // Reuses one client instance in-process.
  if (cachedClient) {
    return cachedClient;
  }

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    throw new Error("Turso is not configured. Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN.");
  }

  cachedClient = createClient({
    url,
    authToken,
  });
  return cachedClient;
}

export async function executeTurso(statement: InStatement | string, timeoutMs?: number) {
  // Fails fast if query exceeds timeout; avoids hanging requests.
  const client = getTursoClient();
  const queryTimeoutMs = timeoutMs ?? getTursoQueryTimeoutMs();

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Turso query timed out after ${queryTimeoutMs}ms.`));
    }, queryTimeoutMs);
  });

  try {
    return await Promise.race([client.execute(statement), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
