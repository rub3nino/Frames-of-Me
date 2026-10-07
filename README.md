# RePhoto

RePhoto trova le foto di un evento a partire da un selfie. I fotografi caricano gli scatti; il sistema li indicizza con un motore di riconoscimento **self-hosted** (InsightFace su CPU dietro un piccolo servizio HTTP, rilevamento a 2560 px, vettori in Postgres + pgvector; in locale un motore `fake` senza dipendenze; Amazon Rekognition resta disponibile come alternativa); il partecipante dà il consenso, scatta un selfie con la camera seguendo una breve challenge (o carica un file), riceve per e-mail il link alla sua galleria e scarica le foto, singole o in ZIP. Il file del selfie si cancella dopo la ricerca; il vettore del suo volto resta nella galleria, così le foto caricate in seguito vengono agganciate senza un nuovo selfie, anche se al momento del selfie non c'era ancora nessuna foto. Un selfie senza volto, troppo piccolo o con due persone viene rifiutato con un motivo; una foto sbagliata si toglie con «Non sono io». Tutto gira su un solo VPS in Europa (Caddy, Postgres, MinIO, face-service, posta via provider SMTP): nessun servizio cloud gestito.

Tre ruoli, tre ingressi:

| Ruolo | Come entra | Cosa fa |
| --- | --- | --- |
| **Partecipante** | magic link via e-mail (o QR emesso dall'admin in sala) | consenso, selfie (camera con challenge o file), galleria (`/e/{slug}`), «Non sono io», download e ZIP |
| **Fotografo** | invito e-mail dell'admin (`/invito`) o link dall'admin, poi magic link da `/staff` | upload da browser (`/upload`), con resume e stato delle foto; su Chrome/Edge una cartella sorvegliata che carica da sola ogni nuovo scatto, prima la versione web e poi l'originale |
| **Admin** | magic link da `/staff` (utente da seed, da SQL, da `BOOTSTRAP_ADMINS` o da un link di un altro admin) | console `/admin`: stato della coda e del motore, eventi, link di accesso con QR, gallerie per e-mail con punteggi, pagina di debug di ogni foto (volti, vicini con coseno, gallerie), export CSV, inviti e accesso dell'evento, import partecipanti, cancellazioni, retention, reset dell'evento |

Componenti: API Hono (`apps/api`), worker dei job su Postgres (`apps/worker`), web Next.js (`apps/web`), servizio volti Python (`apps/face-service`), pacchetti condivisi (`packages/contracts`, `packages/db`, `packages/face-engine`), stack di produzione (`deploy/`), strumenti della campagna di test (`scripts/ingest` importer server-side, `scripts/seed-test.ts`, `scripts/eval` per precision/recall e null-selfie test, `deploy/compose.test.yml`, `deploy/scripts/status.sh` e `reset-event.sh`). Dimensionato per una conferenza da ~150.000 foto e ~6.000 partecipanti.

Documenti:

- [CONTRACTS.md](CONTRACTS.md) — contratto congelato v5: motori volti (`fake`, `rekognition`, `insightface`), ambiente, chiavi oggetto, job, schema, HTTP (rotte admin comprese), upload a due stadi, uploader web, liveness, vettore del selfie, registro dei match; «Changes from v4» in fondo.
- [RUN.md](RUN.md) — avvio locale (compose con face-service e pgvector), motore `insightface` in locale, selfie con camera, console admin e `/staff`, seed e importer, profilo Docker `app`, test (Node e Python), load test.
- [deploy/README.md](deploy/README.md) — installazione self-hosted su un VPS: dimensionamento, DNS, primo deploy, aggiornamento, backup e ripristino, monitoraggio, provider di posta (SPF/DKIM), giorni dell'evento, costi; §9 bis la campagna di test.
- [docs/infra.md](docs/infra.md) — topologia dello stack self-hosted, dimensionamento su CPU (rilevamento a 2560 px), rete in sala, runbook dell'evento; lo stack AWS (`infra/cdk`) come alternativa.
- [docs/DPIA.md](docs/DPIA.md) — bozza di DPIA allineata al codice v5 (template biometrici a riposo nel nostro Postgres, vettore del selfie per galleria, hosting UE, liveness come deterrente, strumenti di test); non firmata.
- [docs/test-readiness.md](docs/test-readiness.md) — analisi di prontezza per la campagna di test e [docs/v5-test-readiness-spec.md](docs/v5-test-readiness-spec.md) — la spec v5 che ne è seguita; [scripts/ingest/README.md](scripts/ingest/README.md) e [scripts/eval/README.md](scripts/eval/README.md) — importer e valutazione.
- [apps/face-service/README.md](apps/face-service/README.md) — il servizio InsightFace: endpoint, liveness, `/metrics`, variabili, avvio e test.
- [docs/v4-selfhost-spec.md](docs/v4-selfhost-spec.md) — nota di progetto della v4 (self-hosted); [docs/v3-uploader-spec.md](docs/v3-uploader-spec.md) — uploader continuo (v3); [docs/v2-spec.md](docs/v2-spec.md) — v2; [docs/ux-flows.md](docs/ux-flows.md) — studio dei flussi pre-design; [docs/ses-produzione.md](docs/ses-produzione.md) — uscita dalla sandbox SES (solo con l'alternativa AWS).
