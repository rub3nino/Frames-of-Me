# Load test (k6)

Due script [k6](https://k6.io) che esercitano i due percorsi caldi del contratto: l'upload dei fotografi e la ricerca per selfie dei partecipanti. Non toccano il database: parlano solo con l'API, come farebbero i browser.

| Script | Cosa fa | Metriche principali |
| --- | --- | --- |
| `upload.js` | 12 fotografi virtuali caricano in continuo JPEG da ~2 MB: `init` → PUT presigned → `complete` | `upload_init`, `upload_put`, `upload_complete`, `upload_total`, `upload_errors` |
| `selfie.js` | 1.000 selfie in 10 minuti (arrival rate costante); ogni selfie fa polling di `GET /v1/events/{slug}/gallery` finché `status === "ready"` | `selfie_post`, `time_to_ready`, `gallery_poll`, `ready_timeouts`, `selfie_errors` |

`fixtures/sample.jpg` è un JPEG sintetico 640×480 (19 KB). `upload.js` lo riempie con byte casuali dopo il marker EOI fino a `UPLOAD_BYTES` (default 2 MiB): il decoder ignora la coda, lo sha256 cambia a ogni upload e l'API non risponde `409`. Con `FACE_ENGINE=fake` il motore confronta il colore medio, quindi tutti i selfie trovano tutte le foto caricate dallo stesso fixture.

## Prerequisiti

- `k6` installato (`brew install k6`).
- Cookie di sessione validi. L'autenticazione è a magic link, quindi gli script non fanno login: prendono il valore del cookie `rephoto_session` dall'ambiente.
  - Fotografi (`SESSION_COOKIES`): utenti con ruolo `photographer` membri dell'evento (`event_photographers`).
  - Partecipanti (`PARTICIPANT_COOKIES`): utenti con ruolo `participant`. L'API ammette **5 selfie per utente ogni ora**, quindi 1.000 selfie richiedono almeno 200 cookie; con meno cookie le iterazioni in eccesso ricevono `429` e finiscono in `selfie_errors`. Il consenso viene dato una volta per cookie in `setup()`.

Il modo rapido è `scripts/seed-test.ts`, che crea evento, fotografi (membri dell'evento) e partecipanti (con consenso) e scrive i cookie già nel formato atteso qui:

```sh
npm run seed:test -- --event demo --photographers 12 --participants 200 --out ./seed
k6 run -e SESSION_COOKIES="$(cat seed/cookies-photographers.txt)" ... scripts/loadtest/upload.js
k6 run -e PARTICIPANT_COOKIES="$(cat seed/cookies-participants.txt)" ... scripts/loadtest/selfie.js
```

A mano: `POST /v1/auth/request-link` per ogni email, leggere il link in Mailpit (http://localhost:8025), chiamare `POST /v1/auth/verify` con il token e copiare `rephoto_session` dall'header `Set-Cookie`. Per molti utenti conviene uno script che ripete questi tre passi leggendo Mailpit via API (`GET /api/v1/messages`).

Per riempire il database di foto senza passare dall'API (150k file) c'è `scripts/ingest/` (`npm run ingest`); `upload.js` resta il test del percorso HTTP dei fotografi. Sul server di test i rate limit sono spenti da `deploy/compose.test.yml` (`SELFIE_MAX_PER_HOUR=0`), quindi il vincolo dei 200 cookie vale solo con i limiti di produzione.

## Locale

```sh
docker compose up -d
npm run dev:api & npm run dev:worker &
k6 run -e BASE_URL=http://localhost:8787 -e EVENT_SLUG=demo \
  -e SESSION_COOKIES="$(cat cookies-photographers.txt)" scripts/loadtest/upload.js
k6 run -e BASE_URL=http://localhost:8787 -e EVENT_SLUG=demo \
  -e PARTICIPANT_COOKIES="$(cat cookies-participants.txt)" scripts/loadtest/selfie.js
```

Note locali: gli URL presigned puntano a `http://localhost:9000` (MinIO), raggiungibile dalla macchina che esegue k6. Con il profilo `app` di compose puntano a `http://minio:9000`: serve la riga `127.0.0.1 minio` in `/etc/hosts`.

## Staging / AWS

Puntare `BASE_URL` all'origine pubblica (CloudFront), non all'ALB: l'ALB risponde `403` senza l'header che aggiunge CloudFront. Il WAF blocca oltre 300 richieste ogni 5 minuti per IP su `/v1/auth/*`: non è un problema per questi script (non chiamano `/v1/auth`), lo è per lo script che genera i cookie, che va eseguito con calma o da più IP.

Con `FACE_ENGINE=rekognition` ogni selfie è una `SearchFacesByImage` e ogni upload una `IndexFaces`: 1.000 selfie in 10 minuti sono ~1,7 TPS, entro la quota di default (5 TPS); il worker la limita a `REKOGNITION_SEARCH_TPS` per istanza.

## Parametri

| Variabile | Default | Script |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8787` | entrambi |
| `EVENT_SLUG` | `demo` | entrambi |
| `SESSION_COOKIES` | — | `upload.js` |
| `VUS` / `DURATION` / `UPLOAD_BYTES` | `12` / `5m` / `2097152` | `upload.js` |
| `PARTICIPANT_COOKIES` | — | `selfie.js` |
| `SELFIES` / `DURATION_MINUTES` | `1000` / `10` | `selfie.js` |
| `POLL_SECONDS` / `READY_TIMEOUT_SECONDS` | `2` / `300` | `selfie.js` |
| `CONSENT_TEXT_VERSION` | `2026-10-06` | `selfie.js` |

Soglie (`thresholds`) nei file: `upload_init` p95 < 500 ms, `upload_complete` p95 < 1 s, `selfie_post` p95 < 1 s, `time_to_ready` p95 < 60 s. k6 esce con codice diverso da zero se una soglia non regge.

Limite noto di `selfie.js`: un partecipante che riceve più selfie nella stessa finestra vede la galleria sostituita a ogni `match`; `time_to_ready` misura il primo `ready` dopo la POST, che con una galleria già pronta può arrivare prima del match nuovo. Per una misura pulita usare un cookie per selfie.
