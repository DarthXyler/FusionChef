import type { Metadata } from "next";
import { AdminMonetizationConfigPanel } from "@/components/AdminMonetizationConfigPanel";

export const metadata: Metadata = {
  title: "Monetization Admin",
  description: "Internal runtime monetization controls.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminMonetizationPage() {
  return <AdminMonetizationConfigPanel />;
}
