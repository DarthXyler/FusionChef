import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: "/privacy-policy",
        destination: "/privacy",
        permanent: true,
      },
      {
        source: "/terms-and-conditions",
        destination: "/terms",
        permanent: true,
      },
      {
        source: "/refunds",
        destination: "/refund-policy",
        permanent: true,
      },
      {
        source: "/help",
        destination: "/support",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
