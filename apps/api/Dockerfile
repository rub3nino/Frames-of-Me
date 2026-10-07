# RePhoto API. Build context is the repo root:
#   docker build -f apps/api/Dockerfile -t rephoto-api .
# Runs TypeScript directly through tsx (a runtime dependency), as in local dev.
# Package manager: pnpm via Corepack, pinned by the root package.json `packageManager`.

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

# ---- install: prod deps for the api and the workspace packages it imports ----
FROM base AS deps
# Manifests + lockfile first so the install layer is cached until a dependency changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/face-engine/package.json packages/face-engine/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @rephoto/api...

# ---- runtime: minimal, non-root ----
FROM base
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app /app
# Sources of the api and of the packages it imports (tsx runs the TypeScript directly).
COPY --chown=node:node packages/contracts packages/contracts
COPY --chown=node:node packages/db packages/db
COPY --chown=node:node packages/face-engine packages/face-engine
COPY --chown=node:node apps/api apps/api

USER node
WORKDIR /app/apps/api
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
