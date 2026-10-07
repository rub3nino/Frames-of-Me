# RePhoto

RePhoto trova le foto di un evento a partire da un selfie. I fotografi caricano gli scatti; il sistema li indicizza con un motore di riconoscimento **self-hosted** (InsightFace su CPU dietro un piccolo servizio HTTP, vettori in Postgres + pgvector; in locale un motore `fake` senza dipendenze; Amazon Rekognition resta disponibile come alternativa); il partecipante dà il consenso, scatta un selfie con la camera seguendo una breve challenge (o carica un file), riceve per e-mail il link alla sua galleria e scarica le foto, singole o in ZIP. Il selfie si cancella dopo la ricerca; le foto caricate in seguito vengono agganciate alla galleria senza un nuovo selfie, usando gli identificatori dei volti già riconosciuti. Tutto gira su un solo VPS in Europa (Caddy, Postgres, MinIO, face-service, posta via provider SMTP): nessun servizio cloud gestito.

Tre ruoli, tre ingressi:

| Ruolo | Come entra | Cosa fa |
| --- | --- | --- |
| **Partecipante** | magic link via e-mail | consenso, selfie (camera con challenge o file), galleria (`/e/{slug}`), download e ZIP |
| **Fotografo** | invito e-mail dell'admin (`/invito`), poi magic link | upload da browser (`/upload`), con resume e stato delle foto; su Chrome/Edge una cartella sorvegliata che carica da sola ogni nuovo scatto, prima la versione web e poi l'originale |
| **Admin** | magic link (utente da seed o da SQL) | inviti, accesso dell'evento aperto o a elenco, import partecipanti, metriche, cancellazioni, retention |

Componenti: API Hono (`apps/api`), worker dei job su Postgres (`apps/worker`), web Next.js (`apps/web`), servizio volti Python (`apps/face-service`), pacchetti condivisi (`packages/contracts`, `packages/db`, `packages/face-engine`), stack di produzione (`deploy/`). Dimensionato per una conferenza da ~150.000 foto e ~6.000 partecipanti.

Documenti:

- [CONTRACTS.md](CONTRACTS.md) — contratto congelato v4: motori volti (`fake`, `rekognition`, `insightface`), ambiente, chiavi oggetto, job, schema, HTTP, upload a due stadi, uploader web, liveness.
- [RUN.md](RUN.md) — avvio locale (compose con face-service e pgvector), motore `insightface` in locale, selfie con camera, profilo Docker `app`, test (Node e Python), load test.
- [deploy/README.md](deploy/README.md) — installazione self-hosted su un VPS: dimensionamento, DNS, primo deploy, aggiornamento, backup e ripristino, monitoraggio, provider di posta (SPF/DKIM), giorni dell'evento, costi.
- [docs/infra.md](docs/infra.md) — topologia dello stack self-hosted, dimensionamento su CPU, rete in sala, runbook dell'evento; lo stack AWS (`infra/cdk`) come alternativa.
- [docs/DPIA.md](docs/DPIA.md) — bozza di DPIA allineata al codice v4 (template biometrici a riposo nel nostro Postgres, hosting UE, liveness come deterrente); non firmata.
- [apps/face-service/README.md](apps/face-service/README.md) — il servizio InsightFace: endpoint, liveness, variabili, avvio e test.
- [docs/v4-selfhost-spec.md](docs/v4-selfhost-spec.md) — nota di progetto della v4 (self-hosted); [docs/v3-uploader-spec.md](docs/v3-uploader-spec.md) — uploader continuo (v3); [docs/v2-spec.md](docs/v2-spec.md) — v2; [docs/ux-flows.md](docs/ux-flows.md) — studio dei flussi pre-design; [docs/ses-produzione.md](docs/ses-produzione.md) — uscita dalla sandbox SES (solo con l'alternativa AWS).
