# RePhoto API. Build context is the repo root:
#   docker build -f apps/api/Dockerfile -t rephoto-api .
# Runs TypeScript directly through tsx (a runtime dependency), as in local dev.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Manifests first so the npm ci layer is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/face-engine/package.json packages/face-engine/
RUN npm ci --workspaces --include-workspace-root

# Sources of the api and of the packages it imports.
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/face-engine packages/face-engine
COPY apps/api apps/api

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=builder --chown=node:node /app /app

USER node
WORKDIR /app/apps/api
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
