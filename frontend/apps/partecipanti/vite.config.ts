import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The participant SPA. Served behind a proxy that routes /v1 -> the API, so the
// browser sees the API as same-origin and the session cookie just works.
// In dev, Vite is that proxy (see server.proxy below).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ui": path.resolve(__dirname, "../../packages/ui"),
      "@api": path.resolve(__dirname, "../../packages/api-client/index.mjs"),
    },
  },
  server: {
    port: 5190,
    // allow importing the shared packages that live outside this app's root
    fs: { allow: [path.resolve(__dirname, "../..")] },
    proxy: {
      "/v1": { target: process.env.API_PROXY_TARGET || "http://localhost:8787", changeOrigin: true },
    },
  },
});
