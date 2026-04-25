/**
 * Auth user profile persistence.
 * New login creates profile automatically; returning login reuses existing profile.
 */
import { randomUUID } from "crypto";
import { executeTurso } from "@/lib/turso";

type OAuthProvider = "google";

export type AuthUserRecord = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
  provider: OAuthProvider;
  providerSubject: string;
  role: "user" | "admin";
};

let authSchemaReady: Promise<void> | null = null;

async function ensureAuthSchema() {
  if (authSchemaReady) {
    return authSchemaReady;
  }
  authSchemaReady = (async () => {
    await executeTurso({
      sql: `CREATE TABLE IF NOT EXISTS auth_users (
              id TEXT PRIMARY KEY,
              email TEXT NOT NULL,
              normalized_email TEXT NOT NULL,
              name TEXT NOT NULL,
              avatar_url TEXT NOT NULL,
              provider TEXT NOT NULL,
              provider_subject TEXT NOT NULL,
              role TEXT NOT NULL,
              last_login_at TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            )`,
    });
    await executeTurso({
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_provider_subject
            ON auth_users(provider, provider_subject)`,
    });
    await executeTurso({
      sql: `CREATE INDEX IF NOT EXISTS idx_auth_users_normalized_email
            ON auth_users(normalized_email)`,
    });
  })();
  return authSchemaReady;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeName(name: string, fallbackEmail: string) {
  const trimmed = name.trim();
  if (trimmed) {
    return trimmed.slice(0, 120);
  }
  return fallbackEmail.slice(0, 120);
}

function normalizeAvatarUrl(value: string) {
  return value.trim().slice(0, 500);
}

function normalizeSubject(value: string) {
  return value.trim().slice(0, 160);
}

export async function upsertOAuthUser(params: {
  provider: OAuthProvider;
  providerSubject: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: "user" | "admin";
}) {
  await ensureAuthSchema();
  const now = new Date().toISOString();
  const normalizedEmail = normalizeEmail(params.email);
  const providerSubject = normalizeSubject(params.providerSubject);
  const name = normalizeName(params.name, normalizedEmail);
  const avatarUrl = normalizeAvatarUrl(params.avatarUrl ?? "");

  const existing = await executeTurso({
    sql: `SELECT id
          FROM auth_users
          WHERE provider = ? AND provider_subject = ?
          LIMIT 1`,
    args: [params.provider, providerSubject],
  });
  const existingId = existing.rows[0]?.id;
  const userId = typeof existingId === "string" && existingId.trim().length > 0 ? existingId : randomUUID();

  await executeTurso({
    sql: `INSERT INTO auth_users (
            id,
            email,
            normalized_email,
            name,
            avatar_url,
            provider,
            provider_subject,
            role,
            last_login_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, provider_subject) DO UPDATE SET
            email = excluded.email,
            normalized_email = excluded.normalized_email,
            name = excluded.name,
            avatar_url = excluded.avatar_url,
            role = excluded.role,
            last_login_at = excluded.last_login_at,
            updated_at = excluded.updated_at`,
    args: [
      userId,
      params.email.trim(),
      normalizedEmail,
      name,
      avatarUrl,
      params.provider,
      providerSubject,
      params.role,
      now,
      now,
    ],
  });

  return {
    id: userId,
    email: params.email.trim(),
    name,
    avatarUrl,
    provider: params.provider,
    providerSubject,
    role: params.role,
  } satisfies AuthUserRecord;
}

