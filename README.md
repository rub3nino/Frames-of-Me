<div align="center">

<img src="docs/assets/logo.svg" alt="Frames of Me" width="220" />

### Ritrova le tue foto di un evento partendo da un selfie.

**[→ framesofme.com](https://framesofme.com)** · ambiente di test online

</div>

---

## Cos'è Frames of Me

Frames of Me è l'app che a un evento (una conferenza, un matrimonio, un festival) risolve un problema
banale ma fastidioso: **tra decine di migliaia di scatti, trovare quelli in cui ci sei tu.**

Il partecipante non sfoglia niente. Dà il consenso, si fa un **selfie** con la fotocamera (o carica
un file), e il sistema gli manda via e-mail il link a una **galleria personale** con solo le foto in
cui compare. Da lì scarica le singole foto o uno ZIP. I fotografi, intanto, caricano gli scatti da
browser; il motore di riconoscimento facciale li indicizza man mano.

Il selfie serve solo a trovarti: il **file** del selfie si cancella subito dopo la ricerca. Resta il
**vettore** matematico del volto, legato alla tua galleria, così le foto caricate *dopo* il tuo
selfie ti vengono agganciate da sole, senza doverti fotografare di nuovo.

> **In una riga:** carichi/scatti foto → riconoscimento facciale self-hosted → ognuno riceve le
> proprie foto. Dimensionato per una conferenza da **~150.000 foto** e **~6.000 partecipanti**.

---

## L'obiettivo (dove vogliamo arrivare)

Il prodotto finale è un posto unico dove, come utente, puoi:

1. **Accedere a una galleria dell'evento** e trovare le tue foto da un selfie — *questo funziona già*.
2. **Caricare o scattare le tue foto** dentro l'app e **applicare il filtro/cornice ufficiale
   della Conferenza 2026** (una cornice stile Polaroid con nome e data dell'evento + un paio di
   filtri), così da alimentare un "album di tutti" (crowd gallery) oltre a quello ufficiale dei
   fotografi — *in costruzione, vedi [Stato](#stato-del-progetto-cosa-cè-e-cosa-no)*.

La parte **più importante e delicata è il riconoscimento facciale**. Abbiamo scelto di farlo **in
casa**, con un motore **open source**, invece di appoggiarci a un servizio cloud gestito. Il perché
è spiegato sotto.

---

## Come funziona il riconoscimento facciale

È il cuore del progetto. Usiamo un motore **open source self-hosted**, non un servizio a pagamento.

- **Motore: [InsightFace](https://github.com/deepinsight/insightface)** (modelli ONNX `buffalo_l`),
  girato su **CPU** dietro un piccolo servizio HTTP in Python ([`apps/face-service`](apps/face-service)).
  Rileva i volti, produce per ognuno un **embedding a 512 dimensioni** e calcola la somiglianza tra
  due volti come **coseno** tra i vettori.
- **Dove vivono i vettori:** in **Postgres con l'estensione [pgvector](https://github.com/pgvector/pgvector)**,
  con indice HNSW per la ricerca per similarità. Niente collezioni gestite da terzi: i template
  biometrici stanno nel *nostro* database.
- **Il flusso:** il worker, per ogni foto caricata, chiede al face-service i volti e salva i vettori
  (rilevamento a **2560 px** per non perdere i volti piccoli in fondo alla sala). Quando un
  partecipante fa il selfie, cerchiamo i volti più vicini al vettore del selfie e costruiamo la sua
  galleria. Le soglie di coseno (`MIN` / `SURE`) decidono "Forse sei tu" vs "Le tue foto".
- **Qualità dei match:** un selfie senza volto, troppo piccolo o con due persone viene **rifiutato
  con un motivo**; una foto sbagliata nella galleria si toglie con **«Non sono io»**; i volti sotto
  una certa qualità non vengono indicizzati.

### Cosa abbiamo fatto / cosa no, sul riconoscimento

| | |
| --- | --- |
| ✅ Fatto | Motore InsightFace self-hosted, embedding + ricerca pgvector, indicizzazione a 2560 px, aggancio automatico delle foto successive al selfie, gate di qualità del selfie, «Non sono io», registro dei match per valutare precision/recall. |
| 🧪 Deterrente | **Liveness** leggera (una breve *challenge* durante il selfie) come deterrente, non come garanzia anti-spoofing. |
| 🚧 In corso | Isolamento dei vettori **per album** (vedi v6) così che l'album "di tutti" non venga mai indicizzato e la ricerca resti precisa con più album per evento. |

> **Nota per chi mette le mani nel codice:** esistono **tre motori** dietro la stessa interfaccia
> (`FACE_ENGINE`): `insightface` (quello vero, self-hosted), `fake` (nessuna dipendenza, default in
> locale, per sviluppare senza GPU/CPU pesante) e `rekognition` (Amazon, tenuto come alternativa ma
> **non** è la strada scelta). Il contratto è congelato in [CONTRACTS.md](CONTRACTS.md).

---

## Stato del progetto (cosa c'è e cosa no)

Frames of Me è cresciuto per versioni; ogni spec sta in [`docs/`](docs). Riassunto onesto di **a che
punto siamo**:

- **Backend — v5, funzionante e testato.** API ([`apps/api`](apps/api), Hono), worker dei job su
  Postgres ([`apps/worker`](apps/worker)), UI attuale in Next.js ([`apps/web`](apps/web)),
  face-service Python ([`apps/face-service`](apps/face-service)), pacchetti condivisi
  ([`packages/*`](packages)). Tutto il flusso **partecipante / fotografo / admin** gira oggi.
- **Frontend nuovo — in porting.** In [`frontend/`](frontend) stiamo ricostruendo l'interfaccia come
  **quattro app indipendenti** (`landing`, `partecipanti`, `fotografi`, `admin`) che condividono un
  design system (`packages/ui`) e un client API tipizzato. Oggi **solo la `landing` è un'app vera e
  pronta al deploy**; le altre tre sono ancora il **prototipo visivo** (HTML statico) da portare
  riusando la logica già funzionante di `apps/web`. Roadmap in [`frontend/README.md`](frontend/README.md).
- **v6 — progettata, in implementazione.** Decisioni congelate in [`docs/v6-spec.md`](docs/v6-spec.md):
  **album** multipli per evento (un "ufficiale" dei fotografi + uno "crowd" di tutti), un album
  crowd che **non viene mai riconosciuto** (vincolo a livello di DB), **login Google + registrazione
  con codice evento**, moderazione, e **il filtro/cornice** composto su canvas dopo lo scatto. È qui
  che vive la feature "scatta e applica il filtro ufficiale 2026".

Chi prende in mano il codice oggi dovrebbe partire da **`apps/web` + `apps/api`** (la cosa che
funziona) e leggere `docs/v6-spec.md` per capire dove sta andando.

### Mappa del repo

```
apps/
  api/          API HTTP (Hono) — auth, eventi, selfie, gallerie, upload, rotte admin
  worker/       worker dei job su Postgres (indicizzazione volti, resize, match, ZIP…)
  web/          UI attuale (Next.js) — partecipante, fotografo, admin  ← la cosa che funziona oggi
  face-service/ servizio Python InsightFace (CPU) dietro HTTP
packages/
  contracts/    contratto condiviso (motori volti, job, schema, HTTP) — v. CONTRACTS.md
  db/           schema, migrazioni, accesso a Postgres (+ pgvector)
  face-engine/  astrazione del motore volti (insightface | fake | rekognition)
frontend/       il NUOVO frontend in costruzione (4 app + design system)  ← vedi frontend/README.md
deploy/         stack self-hosted "classico" su VPS (Caddy, compose, backup, runbook)
docs/           spec per versione (v2→v6), DPIA, infra, flussi UX  ← inizia da v6-spec.md
scripts/        importer server-side, seed, valutazione precision/recall
docker-compose*.yml   stack locale e stack Coolify (produzione/test)
```

### I tre ruoli

| Ruolo | Come entra | Cosa fa |
| --- | --- | --- |
| **Partecipante** | magic link via e-mail (o QR emesso dall'admin in sala) | consenso, selfie (camera con challenge o file), galleria `/e/{slug}`, «Non sono io», download e ZIP |
| **Fotografo** | invito dell'admin, poi magic link da `/staff` | upload da browser con resume e stato; su Chrome/Edge una cartella sorvegliata che carica da sola ogni nuovo scatto |
| **Admin** | magic link da `/staff` | console `/admin`: stato coda e motore, eventi, QR di accesso, gallerie per e-mail, debug di ogni foto, export CSV, inviti, retention, reset evento |

---

## Lato server: come (e perché) è messo su

### La scelta: self-hosted, niente cloud gestito

Frames of Me è progettato per **girare su un solo VPS in Europa**, senza servizi cloud gestiti. La ragione
è il tipo di dato: **template biometrici dei volti.** Tenerli dentro un nostro Postgres in UE —
invece di spedirli a un servizio come Rekognition — rende molto più semplice e difendibile il discorso
privacy/GDPR (vedi la bozza di DPIA in [`docs/DPIA.md`](docs/DPIA.md)). Da qui la scelta di
InsightFace + pgvector al posto del cloud: **i volti non escono dalla nostra infrastruttura.**

Lo stack è tutto in container: **Postgres (pgvector)**, **MinIO** (storage S3-compatibile per le
foto), il **face-service**, API, worker, web e la **posta via SMTP** (Mailpit in test, un provider
reale in produzione). La topologia e il dimensionamento (CPU, RAM, disco per ~150k foto) sono in
[`docs/infra.md`](docs/infra.md); il runbook "VPS classico" con Caddy e backup in
[`deploy/README.md`](deploy/README.md).

### Il server di adesso è provvisorio

**Attenzione: oggi l'ambiente pubblico è un server temporaneo, di test, non la produzione finale.**

- Gira su **[Coolify](https://coolify.io)** (self-hosted PaaS) dal file
  [`docker-compose.coolify.yml`](docker-compose.coolify.yml), progetto *"Frames of Me"*, ambiente *"test"*.
- Le migrazioni partono una tantum da un servizio `migrate` dedicato prima che API/worker salgano.
- I **segreti e gli URL** non stanno nel repo: si impostano nelle *Environment Variables* di Coolify
  (lo schema di tutte le variabili è in [`.env.example`](.env.example)).
- È un **banco di prova**: ci serve per far girare la campagna di test end-to-end. L'ambiente
  definitivo (dimensionato per l'evento vero) sarà rifatto seguendo `deploy/` o lo stesso Coolify su
  una macchina adeguata.

### Il dominio è su Cloudflare

Il dominio del prodotto è **[`framesofme.com`](https://framesofme.com)**, gestito su **Cloudflare** (oggi punta all'ambiente di test). 
L'esposizione pubblica passa per un **Cloudflare Tunnel → Traefik di Coolify**: per questo **nessun
container pubblica una porta sull'host** — ognuno `expose` solo la sua porta interna e in Coolify si
mappa l'FQDN al servizio. Mappatura attuale:

| Dominio | Servizio | Porta interna |
| --- | --- | --- |
| `framesofme.com`, `www.framesofme.com` | web (Next.js) | 3000 |
| `api.framesofme.com` | API | 8787 |
| `s3.framesofme.com` | MinIO (URL presigned che apre il browser) | 9000 |
| `mail.framesofme.com` | Mailpit (dietro Cloudflare Access) | 8025 |

> Dettaglio che fa perdere tempo se non lo si sa: l'API firma gli URL presigned di MinIO usando
> `S3_ENDPOINT`, che **deve essere l'host pubblico** (`https://s3.framesofme.com`) perché la firma
> SigV4 include l'host. Cloudflare + Traefik davanti all'API ⇒ `TRUSTED_PROXY_HOPS=2`.

---

## Avvio rapido in locale

Il motore di default in locale è `fake` (nessuna dipendenza): si sviluppa senza GPU né servizio
volti. Per provare il riconoscimento vero serve il face-service + un Postgres con pgvector (li alza
`docker compose`). Dettagli completi in [RUN.md](RUN.md).

```bash
cp .env.example .env            # il default usa il motore `fake`
docker compose up -d            # Postgres (pgvector), MinIO, Mailpit, face-service
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev:api                    # in tre terminali:
pnpm dev:worker
pnpm dev:web                    # → http://localhost:3000
pnpm test                       # test Node (contracts, worker, api, web)
```

Per il riconoscimento reale: metti `FACE_ENGINE=insightface` nel `.env` (il face-service è già su con
`docker compose`).

---

## Documentazione

| Documento | A cosa serve |
| --- | --- |
| [CONTRACTS.md](CONTRACTS.md) | il **contratto congelato** (motori volti, schema, job, HTTP, upload a due stadi, liveness) — la fonte di verità per il backend |
| [RUN.md](RUN.md) | avvio locale completo: compose, motore insightface, selfie con camera, console admin, seed, test, load test |
| [docs/v6-spec.md](docs/v6-spec.md) | **dove sta andando il prodotto**: album, crowd gallery, login Google, filtro/cornice |
| [frontend/README.md](frontend/README.md) | il nuovo frontend (4 app + design system) e la sua roadmap |
| [deploy/README.md](deploy/README.md) | installazione self-hosted su VPS: DNS, deploy, backup, posta, costi |
| [docs/infra.md](docs/infra.md) | topologia e dimensionamento dello stack self-hosted |
| [docs/DPIA.md](docs/DPIA.md) | bozza di DPIA (dati biometrici, hosting UE, liveness) — non firmata |
| [apps/face-service/README.md](apps/face-service/README.md) | il servizio InsightFace: endpoint, liveness, metriche, variabili |
