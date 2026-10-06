FROM node:22-alpine
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/web/tsconfig.json apps/web/tsconfig.json
COPY apps/web/next.config.ts apps/web/next.config.ts
COPY apps/web/next-env.d.ts apps/web/next-env.d.ts
COPY apps/web/app ./apps/web/app
COPY apps/web/components ./apps/web/components
COPY apps/web/lib ./apps/web/lib
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @rephoto/web build

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["pnpm", "--filter", "@rephoto/web", "start"]
