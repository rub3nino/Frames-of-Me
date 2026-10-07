# Frames of Me web (Next.js). Build context is the repo root:
#   docker build -f apps/web/Dockerfile -t rephoto-web .
# Requires `output: "standalone"` in apps/web/next.config.ts. Next infers the monorepo
# root from the root pnpm-lock.yaml, so the standalone bundle lands in
# apps/web/.next/standalone/ with the server at apps/web/server.js inside it.
# node-linker=hoisted (.npmrc) gives a flat node_modules so standalone tracing works.
# NEXT_PUBLIC_* values are inlined at build time: pass them as --build-arg.
# Package manager: pnpm via Corepack, pinned by the root package.json `packageManager`.

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NEXT_TELEMETRY_DISABLED=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

# ---- build: full install (needs dev deps for `next build`) ----
FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/face-engine/package.json packages/face-engine/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @rephoto/web...

COPY packages/contracts packages/contracts
COPY apps/web apps/web

ARG NEXT_PUBLIC_EVENT_SLUG=demo
ARG NEXT_PUBLIC_MEDIA_ORIGINS=http://localhost:9000
ARG NEXT_PUBLIC_WEB_ORIGIN=http://localhost:3000
# A production image must ship the MediaPipe model (the build downloads it; see scripts/fetch-mediapipe.mjs).
ARG MEDIAPIPE_MODEL_REQUIRED=1
ENV MEDIAPIPE_MODEL_REQUIRED=$MEDIAPIPE_MODEL_REQUIRED
ENV NEXT_PUBLIC_EVENT_SLUG=$NEXT_PUBLIC_EVENT_SLUG
ENV NEXT_PUBLIC_MEDIA_ORIGINS=$NEXT_PUBLIC_MEDIA_ORIGINS
ENV NEXT_PUBLIC_WEB_ORIGIN=$NEXT_PUBLIC_WEB_ORIGIN
RUN pnpm --filter @rephoto/web run build

# ---- runtime: Next standalone, non-root ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone output: a pruned node_modules plus the server, rooted at the repo root.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone /app
COPY --from=build --chown=node:node /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public /app/apps/web/public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
