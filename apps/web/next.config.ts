import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@rephoto/contracts"],
  async redirects() {
      return [{ source: "/verifica", destination: "/verify", permanent: false }];
  },
};

export default nextConfig;
