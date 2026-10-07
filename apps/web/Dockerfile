# RePhoto web (Next.js). Build context is the repo root:
#   docker build -f apps/web/Dockerfile -t rephoto-web .
# Requires `output: "standalone"` in apps/web/next.config.ts. Next infers the monorepo
# root from the root package-lock.json, so the standalone bundle lands in
# apps/web/.next/standalone/ with the server at apps/web/server.js inside it.
# NEXT_PUBLIC_* values are inlined at build time: pass them as --build-arg.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/face-engine/package.json packages/face-engine/
RUN npm ci --workspaces --include-workspace-root

COPY packages/contracts packages/contracts
COPY apps/web apps/web

ARG NEXT_PUBLIC_EVENT_SLUG=demo
ARG NEXT_PUBLIC_MEDIA_ORIGINS=http://localhost:9000
ARG NEXT_PUBLIC_WEB_ORIGIN=http://localhost:3000
ENV NEXT_PUBLIC_EVENT_SLUG=$NEXT_PUBLIC_EVENT_SLUG
ENV NEXT_PUBLIC_MEDIA_ORIGINS=$NEXT_PUBLIC_MEDIA_ORIGINS
ENV NEXT_PUBLIC_WEB_ORIGIN=$NEXT_PUBLIC_WEB_ORIGIN
RUN npm run build -w @rephoto/web

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone output: a pruned node_modules plus the server, rooted at the repo root.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone /app
COPY --from=builder --chown=node:node /app/apps/web/.next/static /app/apps/web/.next/static

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
