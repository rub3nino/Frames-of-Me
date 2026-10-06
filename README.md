# RePhoto

RePhoto trova le tue foto di un evento a partire da un selfie. Confronta il volto con gli scatti del fotografo e ti mostra solo le foto in cui compari. Il selfie viene cancellato subito dopo la ricerca. Le foto restano disponibili per 90 giorni.

In locale il confronto volti non chiama AWS (`FACE_ENGINE=fake`). In produzione, solo nella regione `eu-central-1`, lo stesso confine `FaceEngine` usa Amazon Rekognition.

Il contratto congelato è in [CONTRACTS.md](CONTRACTS.md).

## Stack locale

`docker compose up` avvia Postgres 16, MinIO (bucket privato `rephoto`), Mailpit, API, worker e web. Non c'è Qdrant.

| Servizio | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:3001 |
| MinIO | http://localhost:9000 (console http://localhost:9001) |
| Mailpit | http://localhost:8025 |

Copia `.env.example` in `.env` per i processi avviati sull'host. I valori sono segnaposto di sviluppo, non segreti reali.

Le immagini di `api`, `worker` e `web` usano i Dockerfile in `apps/api`, `apps/worker` e `apps/web`. Postgres, MinIO e Mailpit partono anche senza quelle app.
