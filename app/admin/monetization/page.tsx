import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AdminLoginPanel } from "@/components/AdminLoginPanel";
import { AdminMonetizationConfigPanel } from "@/components/AdminMonetizationConfigPanel";
import { isGoogleOauthConfigured } from "@/lib/auth-config";
import { getAuthSessionFromCookies } from "@/lib/auth-session";

export const metadata: Metadata = {
  title: "Monetization Admin",
  description: "Internal runtime monetization controls.",
  robots: {
    index: false,
    follow: false,
  },
};

type AdminMonetizationPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminMonetizationPage({
  searchParams,
}: AdminMonetizationPageProps) {
  const cookieStore = await cookies();
  const session = getAuthSessionFromCookies(cookieStore);
  const params = (await searchParams) ?? {};
  const authErrorRaw = params.authError;
  const authError = typeof authErrorRaw === "string" ? authErrorRaw : "";

  if (!session || session.role !== "admin") {
    return (
      <AdminLoginPanel
        authError={authError}
        isGoogleEnabled={isGoogleOauthConfigured()}
      />
    );
  }

  return <AdminMonetizationConfigPanel defaultActor={session.name} />;
}
