> [!IMPORTANT]
> ## Questo repo è stato diviso in sei, il 9 ottobre 2026
>
> Lo sviluppo continua nell'organizzazione **[Frames-of-Me](https://github.com/Frames-of-Me)**:
>
> | Repo | Cosa contiene |
> |---|---|
> | [platform](https://github.com/Frames-of-Me/platform) | stack docker, deploy, documentazione, ADR, `bootstrap.sh` — **si parte da qui** |
> | [core](https://github.com/Frames-of-Me/core) | contratti, schema, migration, motore di riconoscimento |
> | [backend](https://github.com/Frames-of-Me/backend) | api, worker, face-service |
> | [frontend](https://github.com/Frames-of-Me/frontend) | Angular 22 |
> | [admin](https://github.com/Frames-of-Me/admin) | console di staff (be, fe, setup) |
> | [legacy](https://github.com/Frames-of-Me/legacy) | l'app Next e le quattro app Vite, archivio |
>
> La storia è conservata in ciascuno: `git blame` e `git log --follow` funzionano.
>
> **Questo repo non è archiviato e non va cancellato**: la produzione su Coolify builda ancora
> da qui, e lo spostamento del deploy è una decisione ancora aperta
> ([ADR 0005](https://github.com/Frames-of-Me/platform/blob/main/docs/adr/0005-deploy-ancora-dal-monorepo.md)).
> Conserva anche le issue, le pull request e i tag `archive/*` e `ref/quadra-jet-pre-merge`.
>
> Per lavorare: `git clone https://github.com/Frames-of-Me/platform.git && cd platform && ./bootstrap.sh`

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
> proprie foto. L'obiettivo è una conferenza da **~150.000 foto** e **~6.000 partecipanti** — è il
> numero su cui sono fatte le scelte, **non** una capacità ancora verificata: vedi
> [Capacità](#capacità-cosa-è-misurato-e-cosa-è-un-obiettivo).

---

## L'obiettivo del prodotto

Il prodotto finale è un posto unico dove, come utente, puoi:

1. **Accedere a una galleria dell'evento** e trovare le tue foto da un selfie — *questo funziona già*.
2. **Caricare o scattare le tue foto** dentro l'app e **applicare il filtro/cornice ufficiale
   della Conferenza 2026** (una cornice stile Polaroid con nome e data dell'evento + un paio di
   filtri), così da alimentare un "album di tutti" (crowd gallery) oltre a quello ufficiale dei
   fotografi — *in costruzione, vedi [Stato](#stato-del-progetto-cosa-cè-e-cosa-no)*.

La parte **più importante e delicata è il riconoscimento facciale**. Abbiamo scelto di farlo **in
casa**, con un motore **open source**, invece di appoggiarci a un servizio cloud gestito. Il perché
è spiegato sotto.

La roadmap completa, con quello che è già dentro e quello che è rinviato di proposito, è in
[Dove vogliamo arrivare](#dove-vogliamo-arrivare).

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
- **v6 — implementata, in review.** Decisioni congelate in [`docs/v6-spec.md`](docs/v6-spec.md):
  **album** multipli per evento (un "ufficiale" dei fotografi + uno "crowd" di tutti), un album
  crowd che **non viene mai riconosciuto** (vincolo a livello di DB), **login Google + registrazione
  con codice evento**, moderazione, e **il filtro/cornice** composto su canvas dopo lo scatto. È qui
  che vive la feature "scatta e applica il filtro ufficiale 2026". Insieme a quelle è arrivata la
  parte che mancava sul fronte privacy: **la revoca del consenso** (prima `consents.withdrawn_at`
  esisteva nello schema e **nessuno al mondo poteva scriverlo**) e la **retention automatica** (il
  job esisteva e nessuno lo pianificava).

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
| **Partecipante** | **Accedi con Google**, oppure e-mail + password dietro un **codice evento** (quello sul badge/QR). Il magic link resta nel codice come **riserva per il giorno dell'evento**, nascosto dall'interfaccia | consenso, selfie (camera con challenge o file), galleria `/e/{slug}`, «Non sono io», download e ZIP |
| **Fotografo** | invito dell'admin, poi e-mail + password da `/staff`; autorizzabile **per album**, non solo per evento | upload da browser con resume e stato; su Chrome/Edge una cartella sorvegliata che carica da sola ogni nuovo scatto |
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

## Dove vogliamo arrivare

| Quando | Cosa | Stato |
| --- | --- | --- |
| **v6 — adesso** | Album multipli per evento; album "di tutti" **mai** biometrico; login Google + registrazione con codice evento; moderazione con segnalazioni; cornice Polaroid dell'evento; **revoca del consenso** end-to-end; **retention automatica** con allarme | implementata, in review |
| **v7 — subito dopo** | **Video** nell'album crowd (passthrough H.264, transcodifica solo per l'HEVC degli iPhone, poster frame, 1 video × 15 s a persona, moderazione preventiva, worker separato a concorrenza limitata); **Authentik** come identità dello staff con MFA; **Postgres gestito** invece che sullo stesso host | progettata, non iniziata |
| **più avanti** | Multi-evento reale su una sola installazione; classificatore automatico dei contenuti prima della moderazione umana; alta disponibilità | idee, nessuna decisione |

**Il video è fuori dalla v6 per scelta, non per dimenticanza.** Un video da telefono è 50–300 MB, la
transcodifica è affamata di CPU e competerebbe con l'indicizzazione dei volti proprio durante
l'evento, e soprattutto **non si modera a colpo d'occhio**: un video da 15 secondi costa 15 secondi
di attenzione umana e non si accelera. Il disegno completo è conservato in
[`docs/v6-spec.md`](docs/v6-spec.md) §H.

---

## Capacità: cosa è misurato e cosa è un obiettivo

**«150.000 foto e 6.000 partecipanti» è l'obiettivo del progetto, non una capacità verificata.**
Chi legge il resto del repo troverà quel numero in più posti: è il dimensionamento su cui sono fatte
le scelte, non un risultato misurato su un carico comparabile.

Quello che **è stato misurato** (benchmark `scripts/bench/index-throughput.ts`, sul pipeline vero:
upload reale, `derive → index → attach`, worker e face-service veri, nulla simulato):

| Misura | Valore | Con quale limite |
| --- | --- | --- |
| Throughput indicizzazione | **~12.700 foto/ora** a concorrenza 4 | MacBook arm64, face-service con 4 CPU, e **zero volti nelle foto**: il costo per volto di ArcFace non è mai stato eseguito |
| Ginocchio della concorrenza | **4** | da 4 a 8 il throughput è piatto e la latenza raddoppia: è coda, non lavoro. Più worker **senza** più CPU al face-service non comprano niente |
| Costo della risoluzione | lato lungo 1600 → 2560 costa **~6 %** | il "2×" che si leggeva nei commenti era tutto di `DET_SIZE` 640 → 1024 (1,9×). L'alta risoluzione, che è ciò che fa vedere i volti in fondo alla sala, è quasi gratis: **`DET_SIZE` è l'unica vera leva costo/recall** |
| Recall della ricerca vettoriale | **0,504 → 1,000** | misurato su 2 album × 30.000 vettori; l'1,000 è una scansione esatta che a volume di produzione non regge. Il numero che conterà all'evento è **~0,85** sull'indice HNSW parziale |
| Ripristino completo | **oltre 4 ore** | dominato dalla ricostruzione HNSW e da ~1,2 TB di oggetti, non dal dump del database (19 MB, un secondo) |

**Le tre cose da rifare prima dell'evento**, su hardware e corpus veri:

1. il benchmark con **~200 foto reali** dell'evento (con volti) sulla macchina di produzione — è il
   numero da cui dipende la taglia del server e se l'indicizzazione finisce prima che la galleria
   debba essere online;
2. la **recall a volume reale**, con più album nella stessa tabella;
3. un **ripristino vero** da backup, cronometrato.

---

## Come lavoriamo su questo repo

Il metodo è più rigido del solito perché il dato è biometrico e l'evento non si ripete.

**Una spec per versione, con le decisioni congelate in testa.** `docs/v2…v6-spec.md`. Le decisioni
in cima a una spec **non si rinegoziano** mentre si implementa: si riapre la spec. Quelle della v6:

- un album `crowd` **non può** avere riconoscimento facciale — ed è un `check` del **database**
  (`crowd_never_recognizes`), non un controllo applicativo, così nessun bug e nessun admin distratto
  possono violarlo;
- il flag `recognition` di un album è **immutabile dopo il primo upload**: accenderlo dopo
  cambierebbe la finalità del trattamento su foto già caricate;
- **«non sono io» non è mai una rimozione per tutti.** È un segnale su una persona sola e non conta
  verso la soglia di moderazione, perché è l'esito *normale* di un match sbagliato: tre persone che
  lo premono su una foto di gruppo non devono farla sparire a nessun altro;
- il **magic link non si cancella**: esce dall'interfaccia e resta come riserva del giorno evento.

**Lavoro parallelo ad agenti.** La spec assegna a ogni agente una sezione **con la proprietà
esplicita dei file**, e riserva i numeri di migrazione. Chi aggiunge rotte crea un **file nuovo**
(`apps/api/src/routes.<area>.ts`) con **una riga** di aggancio in `routes.ts`.

> **La lezione dell'integrazione v6, da leggere prima di dividere il lavoro un'altra volta.** La
> regola "appendi alla fine del file" rende i conflitti *meccanici* ma **non sicuri**: il confine di
> un hunk di git cade dove finisce il contesto comune, spesso **dentro** l'ultima dichiarazione di
> un lato, e il risultato è un metodo che non si chiude e centinaia di errori di sintassi lontani
> dalla causa. Il livello database (`packages/db/src/{types,postgres,memory}.ts`) va diviso **per
> file come le rotte**, non lasciato convergere.

**Il cancello, per qualunque modifica:**

```bash
pnpm test        # verde, e con un Postgres vero: i test .pg.test.ts si SALTANO senza
pnpm -r typecheck
```

- Il database serve davvero: i test che contano (vincoli, trigger, `EXPLAIN`, concorrenza) sono i
  `*.pg.test.ts` e **senza `TEST_DATABASE_URL` si saltano in silenzio**. Un conteggio di test che
  cala è un segnale, non un dettaglio.
- Le migrazioni devono applicarsi **anche fuori ordine**: il runner traccia i file applicati per
  nome ([`packages/db/src/migrate.ts`](packages/db/src/migrate.ts)), quindi su un database già
  aggiornato una migrazione con numero più basso arriva **dopo** quelle più alte. Una migrazione non
  può dipendere da numeri successivi al suo.
- **Regola dura:** le gallerie personali da riconoscimento (`galleries`, `gallery_items`) devono
  comportarsi esattamente come prima. Se un test su quelle fallisce, **fermarsi e segnalare**, non
  adattare il test.

### Tre nomi che significano cose diverse

Sbagliarli è il modo più rapido di fare danni in questo schema:

| Nome | Cosa è | Cosa **non** è |
| --- | --- | --- |
| `galleries` | la galleria **personale** di una persona, risultato del match (`unique (user_id, event_id)`) | non è un album creato dall'admin |
| `collection` | una **collection Rekognition** (`rekognitionCollectionId`) | non ha niente a che vedere con gli album |
| `albums` | l'**album** creato dall'admin: ufficiale o di tutti (migrazione 009) | non è `galleries` |

---

## Trappole che costano tempo

Raccolte sul campo; ognuna è costata almeno mezza giornata a qualcuno.

| Trappola | Cosa succede |
| --- | --- |
| **`npm` invece di `pnpm`** | il repo non ha più il campo `workspaces`: ogni `npm -w` fallisce |
| **`node_modules` nel worktree** | senza `pnpm install` nel proprio worktree, `tsc` risolve `@rephoto/*` dal checkout principale e riporta errori fantasma |
| **`pg_isready` mente** | risponde "pronto" durante l'inizializzazione di Postgres; aspettare un vero `select 1` |
| **`export A=x B=$A` in zsh** | `B` prende il valore **vecchio** di `A`. Esportare `DATABASE_URL` e `TEST_DATABASE_URL` in due istruzioni separate, o sei test si saltano in silenzio |
| **immagine `face-service` vecchia** | `/health` risponde `ok` mentre `/v1/embed?max_faces=100` dà 422 e **ogni** job `index` fallisce. Ora il worker se ne accorge all'avvio e si rifiuta di lavorare dicendo perché: `docker compose build face-service` |
| **backtick in un commento SQL** | dentro un template `postgres.js` chiude il literal; l'errore appare righe lontano |
| **`RETURNING` dopo un `update`** | restituisce il valore **nuovo**: per leggere il vecchio serve una CTE `for update` |
| **`mc ilm rule add` non deduplica** | aggiunge una regola identica a ogni deploy; e l'immagine chainguard di MinIO **non ha `grep`** |
| **`audit_log.meta`** | torna dal driver come **stringa** JSON, non come oggetto |

---

## Decisioni aperte

Nessuna di queste blocca lo sviluppo; tutte bloccano qualcosa prima dell'evento.

| Decisione | Blocca | Nota |
| --- | --- | --- |
| **Postgres gestito o sullo stesso host** | la spesa e il piano di continuità | oggi database, foto, elaborazione e servizio volti stanno sulla stessa macchina: è un single point of failure. Con dati biometrici, spostare il database è la prima cosa che farei |
| **Taglia del server** | l'acquisto | dipende dal benchmark con foto vere, non da una stima |
| **`DET_SIZE` 1024 o 640** | recall vs throughput | 640 raddoppia la resa e vede meno i volti piccoli. Scelta attuale: **1024**, da rivedere solo se il benchmark dice che non ci stiamo nei tempi |
| **Quanti upload per persona** nell'album di tutti | il carico di moderazione | è la leva che rende prevedibile il lavoro dei moderatori |
| **Chi modera, in quanti, in che orari** | la policy di moderazione | con due persone la moderazione *preventiva* di tutto non regge: le foto vanno in moderazione *successiva* con segnalazioni, e gli upload aperti solo in orario presidiato |
| **Testo legale e DPIA** | la pubblicazione | la DPIA in [`docs/DPIA.md`](docs/DPIA.md) è una **bozza non firmata**; i testi italiani non sono stati rivisti da un legale |

---

## Costi e infrastruttura prevista

Il piano è **pagare solo ciò che protegge i dati o che sarebbe irresponsabile gestire male**, e
tenere gratuito o self-hosted tutto il resto.

| Voce | Scelta | Ordine di grandezza |
| --- | --- | --- |
| Server | **Hetzner**, 16 vCPU / 32–64 GB, NVMe | 100–220 €/mese nel periodo dell'evento |
| Deploy | **Coolify** self-hosted, solo container stateless | gratuito |
| Edge, DNS, WAF, accessi staff | **Cloudflare** piano gratuito + Access per i pannelli interni | gratuito |
| Foto e backup oggetti | **Cloudflare R2** (compatibile S3, **nessun costo di egress**) | ~1,2–1,5 TB ⇒ 20–35 €/mese, più altrettanti per il backup |
| Posta transazionale | provider SMTP dedicato, SPF + DKIM + DMARC | pochi euro |
| Errori e prodotto | **Sentry** e **PostHog**, piani gratuiti, **mai** selfie, embedding, URL firmate o payload biometrici | 0, da pagare solo nel mese dell'evento se serve |

**Dove non risparmiare: il backup.** Un backup mai ripristinato non è un backup, e il ripristino
reale di questa installazione è di oltre quattro ore. **Dove risparmiare: il numero di servizi
SaaS.** La cosa da evitare è mettere database, storage, identità, osservabilità e PaaS sullo stesso
VPS: un singolo guasto porterebbe via insieme autenticazione, dati, foto e la possibilità di
accorgersene.

I numeri di questa tabella **vanno riverificati alla fonte** prima di impegnare spesa: i listini
cambiano e alcuni qui sono di memoria.

---

## Cosa non è verificato

Elenco onesto, perché vale più di una dichiarazione di completezza:

- **nessun giro end-to-end in un browser** della fotocamera, della cornice e delle pagine nuove:
  sono coperte da test unitari con stub, `tsc` e una build di produzione riuscita;
- **nessun round-trip reale con Google**: il flusso OIDC è provato interamente con un doppio
  iniettato, e le credenziali OAuth non sono ancora state create;
- **niente è stato eseguito su un host di produzione**: la finestra della retention è provata
  passando un `now` esplicito, non aspettando un giorno;
- **l'allarme della retention è una e-mail**, non un pager, e non può partire da un worker spento;
- **i backup conservano le righe revocate** fino a 7 giorni (dump) e 24 ore (mirror degli oggetti):
  una revoca non è completa finché i backup non ruotano;
- il percorso **Rekognition** della revoca non è testato (nessun account) e sotto `insightface` non
  può presentarsi.

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
| [docs/face-throughput.md](docs/face-throughput.md) | il **benchmark** di indicizzazione: numeri misurati, con quali limiti, e come rieseguirlo sull'hardware vero |
| [docs/v6-albums-vector-recall.md](docs/v6-albums-vector-recall.md) | la **recall** della ricerca vettoriale prima e dopo l'isolamento per album |
| [apps/face-service/README.md](apps/face-service/README.md) | il servizio InsightFace: endpoint, liveness, metriche, variabili |
