import type { Metadata } from "next";
import { AdminMonetizationConfigPanel } from "@/components/AdminMonetizationConfigPanel";

export const metadata: Metadata = {
  title: "Monetization Admin",
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminMonetizationPage() {
  return <AdminMonetizationConfigPanel />;
}

