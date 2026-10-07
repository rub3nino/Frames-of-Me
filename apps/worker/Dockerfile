# RePhoto worker. Build context is the repo root:
#   docker build -f apps/worker/Dockerfile -t rephoto-worker .
# The worker imports @rephoto/api (env, face engine, mailer, object store), so the api
# sources are part of this image too. sharp's native binary is installed by npm ci
# for the build platform, which is the same image as the runtime stage.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/face-engine/package.json packages/face-engine/
RUN npm ci --workspaces --include-workspace-root

COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/face-engine packages/face-engine
COPY apps/api apps/api
COPY apps/worker apps/worker

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=builder --chown=node:node /app /app

USER node
WORKDIR /app/apps/worker
# No port: the worker is not a server. Liveness is the process itself (ECS restarts on exit).
CMD ["node", "--import", "tsx", "src/index.ts"]
