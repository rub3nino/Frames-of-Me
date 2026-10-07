import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const API = process.env.API_PROXY_TARGET || "http://localhost:8787";

// Dev-only: forward a presigned PUT to MinIO server-side, so the browser PUTs
// same-origin (no CORS). Mirrors apps/web's /api/s3-put route. upload.ts rewrites
// localhost:9000 PUTs to /api/s3-put?url=...
function s3PutProxy(): Plugin {
  return {
    name: "rephoto-s3-put",
    configureServer(server) {
      server.middlewares.use("/api/s3-put", (req, res) => {
        if (req.method !== "PUT") { res.statusCode = 405; res.end(); return; }
        const target = new URL(req.originalUrl || req.url || "", "http://x").searchParams.get("url");
        if (!target) { res.statusCode = 400; res.end("missing url"); return; }
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", async () => {
          try {
            const ct = req.headers["content-type"];
            const r = await fetch(target, { method: "PUT", body: Buffer.concat(chunks), headers: ct ? { "content-type": String(ct) } : {} });
            res.statusCode = r.status;
            const etag = r.headers.get("etag");
            if (etag) res.setHeader("ETag", etag);
            res.end(await r.text().catch(() => ""));
          } catch (e) { res.statusCode = 502; res.end(String(e)); }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), s3PutProxy()],
  resolve: {
    alias: {
      "@ui": path.resolve(__dirname, "../../packages/ui"),
      "@api": path.resolve(__dirname, "../../packages/api-client/index.mjs"),
    },
  },
  server: {
    port: 5191,
    fs: { allow: [path.resolve(__dirname, "../..")] },
    proxy: { "/v1": { target: API, changeOrigin: true } },
  },
});
