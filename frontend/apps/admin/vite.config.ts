import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ui": path.resolve(__dirname, "../../packages/ui"),
      "@api": path.resolve(__dirname, "../../packages/api-client/index.mjs"),
    },
  },
  server: {
    port: 5192,
    fs: { allow: [path.resolve(__dirname, "../..")] },
    proxy: { "/v1": { target: process.env.API_PROXY_TARGET || "http://localhost:8787", changeOrigin: true } },
  },
});
