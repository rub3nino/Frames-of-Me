# RePhoto

RePhoto trova le foto di un evento a partire da un selfie. I fotografi caricano gli scatti; il sistema li indicizza in una collection Amazon Rekognition dedicata all'evento (in locale un motore `fake` che non chiama AWS); il partecipante dà il consenso, invia un selfie, riceve per e-mail il link alla sua galleria e scarica le foto, singole o in ZIP. Il selfie si cancella dopo la ricerca; le foto caricate in seguito vengono agganciate alla galleria senza un nuovo selfie, usando gli identificatori dei volti già riconosciuti (non vettori, non il selfie). Tutto in `eu-central-1`.

Tre ruoli, tre ingressi:

| Ruolo | Come entra | Cosa fa |
| --- | --- | --- |
| **Partecipante** | magic link via e-mail | consenso, selfie, galleria (`/e/{slug}`), download e ZIP |
| **Fotografo** | invito e-mail dell'admin (`/invito`), poi magic link | upload da browser (`/upload`), con resume e stato delle foto; su Chrome/Edge una cartella sorvegliata che carica da sola ogni nuovo scatto, prima la versione web e poi l'originale |
| **Admin** | magic link (utente da seed) | inviti, accesso dell'evento aperto o a elenco, import partecipanti, metriche, cancellazioni, retention |

Componenti: API Hono (`apps/api`), worker dei job su Postgres (`apps/worker`), web Next.js (`apps/web`), pacchetti condivisi (`packages/contracts`, `packages/db`, `packages/face-engine`). Dimensionato per una conferenza da ~150.000 foto e ~6.000 partecipanti.

Documenti:

- [CONTRACTS.md](CONTRACTS.md) — contratto congelato v3: motore volti, ambiente, chiavi oggetto, job, schema, HTTP, upload a due stadi e comportamento dell'uploader web.
- [RUN.md](RUN.md) — avvio locale, profilo Docker `app`, test, load test.
- [docs/infra.md](docs/infra.md) — stack AWS di riferimento (`infra/cdk`), dimensionamento, quote Rekognition, runbook dell'evento, cosa manca.
- [docs/DPIA.md](docs/DPIA.md) — bozza di DPIA allineata al codice (non firmata).
- [docs/ses-produzione.md](docs/ses-produzione.md) — uscita dalla sandbox SES.
- [docs/v2-spec.md](docs/v2-spec.md) — nota di progetto della v2; [docs/v3-uploader-spec.md](docs/v3-uploader-spec.md) — nota di progetto dell'uploader continuo (v3); [docs/ux-flows.md](docs/ux-flows.md) — studio dei flussi pre-design.
