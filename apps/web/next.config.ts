import path from "node:path";
import type { NextConfig } from "next";

const mediaOrigins = (process.env.NEXT_PUBLIC_MEDIA_ORIGINS || "http://localhost:9000")
  .split(/\s+/)
  .filter(Boolean)
  .join(" ");
const webOrigin = process.env.NEXT_PUBLIC_WEB_ORIGIN || "http://localhost:3000";
const production = process.env.NODE_ENV === "production";

// Next inlines small scripts (hydration data, runtime config) so script-src needs
// 'unsafe-inline'; dev also evals source maps and HMR chunks.
const csp = [
  "default-src 'self'",
  `img-src 'self' blob: data: ${mediaOrigins}`,
  `connect-src 'self' ${mediaOrigins}`,
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${production ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(self)" },
];
if (webOrigin.startsWith("https://")) {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  });
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),
  transpilePackages: ["@rephoto/contracts"],
  async redirects() {
    return [{ source: "/verifica", destination: "/verify", permanent: false }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
