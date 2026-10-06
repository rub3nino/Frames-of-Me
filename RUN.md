# Run locally

API (`8787`), worker, and web (`3000`) are three host processes. Compose only starts Postgres, MinIO, and Mailpit. The MinIO image is `cgr.dev/chainguard/minio` because `minio/minio` is no longer on Docker Hub.

```sh
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:worker
npm run dev:web
```

`npm run dev` prints those three process commands. `npm test` checks the collection-id rule and does not need Docker.

| Service | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:8787 |
| MinIO | http://localhost:9000 (console http://localhost:9001) |
| Mailpit | http://localhost:8025 (SMTP `localhost:1025`) |

Seeded data: event slug `demo`, admin `admin@rephoto.local`, photographer `photographer@rephoto.local` with the invite already accepted. `FACE_ENGINE=fake`. No real secrets are in the repo.
