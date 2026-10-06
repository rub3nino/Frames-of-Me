# Avvio locale

L'MVP non è finito. Il 2026-10-06 i Dockerfile di `api`, `worker` e `web` non sono nel tree, e il `package.json` di root non ha script `migrate` o `seed`. Postgres, MinIO e Mailpit partono lo stesso. Porte prese da `docker-compose.yml`.

```bash
pnpm install
cp .env.example .env
docker compose up -d
```

Seed, da `CONTRACTS.md` §6: all'avvio dell'API, se mancano, crea l'evento `slug=demo` (`EVENT_SLUG`) e l'admin `ADMIN_EMAIL`. Non c'è un comando seed separato. La migrazione SQL non ha ancora un comando: non inventarne uno.

| Cosa | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:3001 |
| Mailpit (SMTP 1025) | http://localhost:8025 |
| Postgres | localhost:5432, database `rephoto` |
| MinIO | http://localhost:9000 (console http://localhost:9001) |

In locale `FACE_ENGINE=fake`: nessun chiamata AWS. La posta finisce in Mailpit.

## Conformità

Bozza DPIA, non firmata: `docs/DPIA.md`. Accesso di produzione SES: `docs/ses-produzione.md`. Note di deploy, non una fattura: `docs/aws.md`.
