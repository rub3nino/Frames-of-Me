FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/face-engine packages/face-engine
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN npm install
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/server.ts"]
