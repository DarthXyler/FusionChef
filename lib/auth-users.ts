/**
 * Auth user profile persistence.
 * New login creates profile automatically; returning login reuses existing profile.
 */
import { randomUUID } from "crypto";
import type { Client } from "@libsql/client";
import { executeTurso, getTursoClient } from "./turso.ts";

type OAuthProvider = "google" | "apple";

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

function rowToAuthUserRecord(row: Record<string, unknown>): AuthUserRecord | null {
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const email = typeof row.email === "string" ? row.email.trim() : "";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const avatarUrl = typeof row.avatar_url === "string" ? row.avatar_url.trim() : "";
  const provider = row.provider === "apple" ? "apple" : row.provider === "google" ? "google" : null;
  const providerSubject =
    typeof row.provider_subject === "string" ? row.provider_subject.trim() : "";
  const role = row.role === "admin" ? "admin" : row.role === "user" ? "user" : null;
  if (!id || !email || !name || !provider || !providerSubject || !role) {
    return null;
  }
  return { id, email, name, avatarUrl, provider, providerSubject, role };
}

export async function getOAuthUserByProviderSubject(params: {
  provider: OAuthProvider;
  providerSubject: string;
}) {
  await ensureAuthSchema();
  const providerSubject = normalizeSubject(params.providerSubject);
  if (!providerSubject) {
    return null;
  }

  const result = await executeTurso({
    sql: `SELECT id, email, name, avatar_url, provider, provider_subject, role
          FROM auth_users
          WHERE provider = ? AND provider_subject = ?
          LIMIT 1`,
    args: [params.provider, providerSubject],
  });

  return rowToAuthUserRecord(result.rows[0] ?? {});
}

export async function getAuthUserById(userId: string) {
  await ensureAuthSchema();
  return getAuthUserByIdReadOnly(userId);
}

/**
 * Reads the current persisted auth principal without attempting schema DDL.
 * Destructive workflows must verify their authoritative schema before this.
 */
export async function getAuthUserByIdReadOnly(
  userId: string,
  options: { client?: Pick<Client, "execute"> } = {},
) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return null;
  }

  const client = options.client ?? getTursoClient();
  const result = await client.execute({
    sql: `SELECT id, email, name, avatar_url, provider, provider_subject, role
          FROM auth_users
          WHERE id = ?
          LIMIT 1`,
    args: [normalizedUserId],
  });

  return rowToAuthUserRecord(result.rows[0] ?? {});
}

export async function updateAuthUserProfile(params: {
  userId: string;
  name?: string;
  avatarUrl?: string;
}) {
  await ensureAuthSchema();
  const userId = params.userId.trim();
  if (!userId) {
    return null;
  }

  const existing = await getAuthUserById(userId);
  if (!existing) {
    return null;
  }

  const nextName =
    typeof params.name === "string" ? normalizeName(params.name, existing.email) : existing.name;
  const nextAvatarUrl =
    typeof params.avatarUrl === "string" ? normalizeAvatarUrl(params.avatarUrl) : existing.avatarUrl;
  const now = new Date().toISOString();

  await executeTurso({
    sql: `UPDATE auth_users
          SET name = ?,
              avatar_url = ?,
              updated_at = ?
          WHERE id = ?`,
    args: [nextName, nextAvatarUrl, now, userId],
  });

  return {
    ...existing,
    name: nextName,
    avatarUrl: nextAvatarUrl,
  } satisfies AuthUserRecord;
}

export async function listAuthUserAvatarUrls() {
  await ensureAuthSchema();
  const result = await executeTurso({
    sql: `SELECT avatar_url
          FROM auth_users
          WHERE avatar_url IS NOT NULL
            AND TRIM(avatar_url) != ''`,
  });

  return result.rows
    .map((row) => (typeof row.avatar_url === "string" ? row.avatar_url.trim() : ""))
    .filter((avatarUrl) => avatarUrl.length > 0);
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
  const hasProvidedName = params.name.trim().length > 0;
  const avatarUrl = normalizeAvatarUrl(params.avatarUrl ?? "");
  const candidateUserId = randomUUID();

  const result = await executeTurso({
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
            name = CASE
              WHEN ? = 1 THEN excluded.name
              ELSE auth_users.name
            END,
            avatar_url = CASE
              WHEN TRIM(excluded.avatar_url) != '' THEN excluded.avatar_url
              ELSE auth_users.avatar_url
            END,
            role = excluded.role,
            last_login_at = excluded.last_login_at,
            updated_at = excluded.updated_at
          RETURNING
            id,
            email,
            name,
            avatar_url,
            provider,
            provider_subject,
            role`,
    args: [
      candidateUserId,
      params.email.trim(),
      normalizedEmail,
      name,
      avatarUrl,
      params.provider,
      providerSubject,
      params.role,
      now,
      now,
      hasProvidedName ? 1 : 0,
    ],
  });

  const persistedUser = rowToAuthUserRecord(result.rows[0] ?? {});
  if (!persistedUser) {
    throw new Error("OAuth user upsert did not return a persisted auth user.");
  }
  return persistedUser;
}
