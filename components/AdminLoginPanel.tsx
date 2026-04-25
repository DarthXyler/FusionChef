"use client";

import { useState } from "react";

type AdminLoginPanelProps = {
  authError?: string;
  isGoogleEnabled: boolean;
};

export function AdminLoginPanel({ authError, isGoogleEnabled }: AdminLoginPanelProps) {
  const [isLoading, setIsLoading] = useState(false);

  return (
    <div className="mx-auto w-full max-w-xl animate-rise-in space-y-6">
      <section className="space-y-3 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <p className="inline-block rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
          Secure Admin
        </p>
        <h1 className="font-serif text-3xl leading-tight text-zinc-900 md:text-4xl">
          Monetization Admin Login
        </h1>
        <p className="text-zinc-700">
          Sign in to access monetization controls. Session stays active for 5 days, then
          re-login is required automatically.
        </p>
      </section>

      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-emerald-900">Continue</h2>
        {isGoogleEnabled ? (
          <a
            href="/api/auth/google/start?returnTo=/admin/monetization"
            onClick={() => setIsLoading(true)}
            className="inline-flex w-full cursor-pointer items-center justify-center rounded-xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-600"
          >
            {isLoading ? "Redirecting..." : "Continue with Google"}
          </a>
        ) : (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Google OAuth is not configured yet. Add `GOOGLE_OAUTH_CLIENT_ID` and
            `GOOGLE_OAUTH_CLIENT_SECRET` in Vercel.
          </p>
        )}

        {authError ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Login failed: {authError}
          </p>
        ) : null}
      </section>
    </div>
  );
}

