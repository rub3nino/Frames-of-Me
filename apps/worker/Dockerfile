# RePhoto worker. Build context is the repo root:
#   docker build -f apps/worker/Dockerfile -t rephoto-worker .
# The worker imports @rephoto/api (env, face engine, mailer, object store), so the api
# sources are part of this image too. sharp's native binary is installed by pnpm for the
# build platform, which is the same base image as the runtime stage.
# Package manager: pnpm via Corepack, pinned by the root package.json `packageManager`.

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

# ---- install: prod deps for the worker and the workspace packages it imports ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/face-engine/package.json packages/face-engine/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @rephoto/worker...

# ---- runtime: minimal, non-root ----
FROM base
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app /app
COPY --chown=node:node packages/contracts packages/contracts
COPY --chown=node:node packages/db packages/db
COPY --chown=node:node packages/face-engine packages/face-engine
COPY --chown=node:node apps/api apps/api
COPY --chown=node:node apps/worker apps/worker

USER node
WORKDIR /app/apps/worker
# No port: the worker is not a server. Liveness is the process itself; Docker/Coolify
# restart it on exit (restart policy in the compose file).
CMD ["node", "--import", "tsx", "src/index.ts"]
