# Infrastruttura self-hosted e runbook dell'evento

Data: 2026-10-07. Sostituisce la versione v3 di questo file, che descriveva lo stack AWS come deploy di riferimento (ora §8). Descrive lo stack in `deploy/compose.yml` così com'è scritto, i numeri su cui è dimensionato e cosa guardare nei tre giorni della conferenza. Le procedure operative (primo deploy, aggiornamento, backup, posta, fail2ban) sono in `deploy/README.md`; qui ci sono la topologia, il dimensionamento su CPU e il runbook. Non è una fattura e niente è stato applicato da una pipeline: si installa a mano con `deploy/scripts/bootstrap.sh`.

## 1. Topologia

Un solo VPS Linux (Debian 12 o Ubuntu 22.04+), Docker + Compose plugin, tutto in `deploy/`:

```
                      Internet
                         │ 443 (TLS Let's Encrypt), 80 → 443
             ┌───────────▼───────────┐
             │ caddy                 │  DOMAIN        /v1/* → api:8787 (body ≤ 70 MB), resto → web:3000
             │ header di sicurezza,  │  media.DOMAIN  → minio:9000 (URL firmati, PUT dal browser, body ≤ 100 MB)
             │ gzip/zstd, access log │  status.DOMAIN → uptime-kuma:3001 (basic auth, opzionale)
             └───┬────────┬──────┬───┘
                 │        │      │                rete interna di Compose (nessuna porta sull'host oltre 80/443)
      ┌──────────▼──┐ ┌───▼───┐ ┌▼──────────────┐
      │ api ×2      │ │ web   │ │ minio         │◄──── worker (originali, derivati, selfie)
      │ 2 vCPU/2 GB │ │       │ │ MINIO_DATA_DIR│◄──── backup (mc mirror)
      └──────┬──────┘ └───────┘ └───────────────┘
             │  jobs (tabella Postgres)
      ┌──────▼──────────────┐     ┌──────────────────────────┐
      │ postgres (pgvector) │◄────│ worker ×2, 4 job in volo │
      │ shm 1g, 4 GB sb     │     │ 3 vCPU/4 GB ciascuno     │
      │ face_vectors + HNSW │     └────────────┬─────────────┘
      └──────┬──────────────┘                  │ POST /v1/embed, /v1/liveness
             │ pg_dump                ┌────────▼─────────┐
      ┌──────▼──────┐                 │ face-service     │  insightface buffalo_l, CPU
      │ backup      │──► BACKUP_DIR   │ 4 thread ONNX,   │  semaforo a 2 inferenze
      │ (2° disco)  │                 │ 4 vCPU/4 GB      │  modelli dentro l'immagine
      └─────────────┘                 └──────────────────┘

   api ──SMTP AUTH + STARTTLS──► provider di posta (unica uscita con dati personali)
   Segreti: .env.production (POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, SESSION_SECRET, SMTP_PASSWORD).
   Coda: tabella Postgres `jobs`. Nessun SQS, nessun CDN, nessun servizio gestito.
```

Punti da tenere a mente:

- **Le URL firmate puntano a `media.DOMAIN`.** L'api e il worker parlano con MinIO su `http://minio:9000` (`S3_ENDPOINT`), ma firmano per `S3_PUBLIC_ENDPOINT=https://media.DOMAIN` (secondo client S3, path-style). Caddy inoltra a MinIO con l'`Host` originale: SigV4 copre l'header, quindi la riga `header_up Host {host}` del `Caddyfile` non si tocca. Miniature, versione web, originali e i PUT dei fotografi passano tutti da Caddy sullo stesso host: non c'è più un bucket «fuori».
- **`TRUSTED_PROXY_HOPS=1`**: Caddy è l'unico proxy, scarta gli `X-Forwarded-*` in ingresso e mette l'IP del client. Con Cloudflare o un altro proxy davanti: `trusted_proxies` nel `Caddyfile` e `TRUSTED_PROXY_HOPS=2`.
- **Il `face-service` è uno solo** e `FACE_SERVICE_URL` è un'URL fissa: Compose non lo replica. Un processo uvicorn, `ONNX_THREADS` (= `FACE_SERVICE_THREADS`, default 4) thread per inferenza, al massimo **2 inferenze contemporanee** (semaforo nel codice); le richieste in più aspettano in coda nel processo. Per dargli più CPU si alzano `FACE_SERVICE_THREADS` e `FACE_SERVICE_CPUS`, non il numero di istanze.
- **I vettori stanno nel database dell'app** (`face_vectors`, 512 float32 per volto, indice HNSW `m = 16, ef_construction = 64`, ricerca con `ef_search = max(100, limit)`). L'`attach` non chiama più un fornitore: per ogni volto di una foto nuova è una query sull'indice. Niente quote, niente throttle; il costo è CPU di Postgres.
- **Nessuna alta disponibilità.** Un host, `restart: unless-stopped`, healthcheck su tutto, `systemd/rephoto.service` al boot, backup giornaliero su secondo disco. Se il VPS muore si ripristina altrove da `BACKUP_DIR` (`deploy/README.md` §6, prova di ripristino prima dell'evento).
- Variabili fissate dallo stack per api e worker: `FACE_ENGINE=insightface`, `FACE_SERVICE_URL=http://face-service:8090`, `INSIGHTFACE_MIN_COSINE=0.45`, `INSIGHTFACE_SURE_COSINE=0.65`, `INSIGHTFACE_MAX_FACES=500`, `INSIGHTFACE_MIN_FACE_QUALITY=0.3`, `FACE_INDEX_TPS=20`, `FACE_SEARCH_TPS=20`, `LIVENESS_CHECK=false`, `WORKER_CONCURRENCY=4`, `DATABASE_POOL_MAX=10`, `MAIL_TRANSPORT=smtp`, `SMTP_STARTTLS=true`, `SEED_DEMO=false`, `WORKER_PUBLISH_METRICS=false`. Si cambiano in `.env.production` e `docker compose up -d <servizio>`; le `NEXT_PUBLIC_*` del web richiedono `build`.

## 2. Numeri dell'evento

| Grandezza | Valore assunto | Da dove |
| --- | --- | --- |
| Foto | 150.000 JPEG in 3 giorni, media 8 MB | `docs/v2-spec.md` |
| Fotografi | 12, upload da desktop | idem |
| Partecipanti | 6.000, fino a 1.000 selfie in 10 minuti nei picchi | idem, `scripts/loadtest/selfie.js` |
| Storage originali | ~1,2 TB | 150k × 8 MB |
| Derivati | ~70 GB (thumb ~50 KB, web ~400 KB) | stima |
| Volti indicizzati | 450.000–750.000 (3–5 per foto di conferenza) | stima: 50 è il tetto per foto, non la media |
| `face_vectors` | 750k × ~2 KB ≈ 1,5 GB di heap + indice HNSW (dello stesso ordine) | pgvector |
| Righe `jobs` | ~470.000 (3 per foto + 2 per selfie); ~620.000 con tutte le foto a due stadi (`derive`, `index`, `attach`, `verify`). Eliminate 7 giorni dopo `done` | pipeline |
| `gallery_items` | ~200.000 (6.000 gallerie × ~30 foto) | stima |
| Chiamate al `face-service` | 150k `/v1/embed` (index) + 6–10k `/v1/embed` (selfie) + 6–10k `/v1/liveness` se attivo | pipeline; l'`attach` è SQL |
| Query HNSW | 450–750k (`attach`, una per volto) + 6–10k (`match`) | pipeline |

Cosa pesa davvero:

- **L'indicizzazione è CPU del `face-service`.** Ogni foto è una detection SCRFD a 640 px più un passaggio ArcFace per volto (~10 ms l'uno). Misure: ~150–180 ms per foto da 1600 px con 6 volti su Apple silicon a 4 thread, ~325 ms nella stessa immagine in un container arm64 (`apps/face-service/README.md`); su 4 vCPU x86 aspettarsi 150–300 ms. Con 2 inferenze in volo e 4 thread l'una, un'istanza sta tra **6 e 8 foto/s** quando le foto arrivano a ritmo pieno (≈ 2 / 0,3 s), meno con molti volti per scatto.
- **`attach` non costa più di `index`.** In v3 erano 600.000 chiamate a un fornitore con quota; ora sono 600.000 query HNSW da pochi millisecondi, nello stesso Postgres. Il collo di bottiglia dell'`attach` sparisce; resta quello del `derive` (resize sharp) e dell'`embed`.
- **Picco di upload.** 12 fotografi che scaricano la scheda a fine sessione: 12.000 foto in un'ora sono 3,3 foto/s, sotto la capacità del `face-service`. Con «prima il web» la foto è cercabile pochi secondi dopo l'arrivo del JPEG da 400 KB.
- **CPU del worker.** `derive` (due resize sharp di un JPEG da 8 MB, uno solo con le foto a due stadi) e il fit sotto 5 MB sono le operazioni CPU del worker. 2 worker × 4 job = 8 job in volo, di cui al massimo 2 dentro il `face-service` nello stesso istante: gli altri stanno in `derive`, `attach`, `verify` o aspettano. `verify` rilegge ogni originale una volta (1,2 TB dal MinIO locale, I/O di disco, priorità 70: non ritarda la ricerca).
- **Postgres.** Connessioni: api 2 × 10 + worker 2 × 10 + 4 per processo del motore + backup ≈ 60 su 200. `shared_buffers` 4 GB e `effective_cache_size` 12 GB sono tarati per 32 GB condivisi (con 16 GB: 2 GB / 6 GB). L'indice HNSW va tenuto in RAM: con 750k vettori sono ~1,5–3 GB, dentro i 4 GB di `shared_buffers`.
- **Egress.** 30 originali per partecipante (240 MB) sono ~1,4 TB in uscita dal VPS in tre giorni: dentro i 20 TB inclusi di un VPS Hetzner, ma è banda del data center da tenere d'occhio con `vnstat` o il pannello del provider. Lo ZIP è servito in streaming dall'api attraverso Caddy (nessun timeout di risposta sul sito web, 60 s sull'api solo per gli header).

## 3. Dimensionamento su CPU

Target (`deploy/README.md` §1): 8–16 vCPU dedicate, 32 GB, disco dati 2 TB NVMe/SSD, disco backup 2 TB separato, 1 Gbit/s.

**Indicizzazione.** Con la configurazione di default (`FACE_SERVICE_THREADS=4`, `FACE_SERVICE_CPUS=4`, `WORKER_REPLICAS=2`, `WORKER_CONCURRENCY=4`) e il `face-service` a 150–300 ms per foto con 2 inferenze in volo, il tetto teorico è ≈ 6–8 foto/s: **150.000 foto in ~6–7 ore** di `face-service` saturo. Il tetto si raggiunge solo se il worker tiene sempre due `index` pronti, cioè se `derive` non lo rallenta: con 8 job in volo e foto a due stadi (un solo resize da 400 KB) è realistico; con originali da 8 MB e due resize, contare 3–5 foto/s (il numero prudente di `deploy/README.md`), cioè 8–14 ore per 150.000 foto. In entrambi i casi il picco di 12.000 foto/ora (3,3/s) sta sotto il tetto e la coda si svuota nell'ora successiva; la notte smaltisce il resto. Con 16 vCPU: `FACE_SERVICE_THREADS=8`, `FACE_SERVICE_CPUS=8`, `WORKER_CPUS=4` (il semaforo resta 2: più thread per inferenza, non più inferenze). Alzare `WORKER_CONCURRENCY` oltre 4–6 senza dare CPU al `face-service` allunga solo la coda interna del servizio.

**Ricerche dei partecipanti.** Un `match` è un `/v1/embed` sul selfie (150–300 ms, stesso semaforo dell'indicizzazione), opzionalmente un `/v1/liveness` (~160 ms), una query HNSW. 1.000 selfie in 10 minuti sono 1,7/s: dentro la capacità anche con l'indicizzazione in corso, perché `match` ha priorità 0 nel claim del worker e passa davanti a `index`/`attach`. Il token bucket `FACE_SEARCH_TPS=20` per processo non è mai il limite. Tempo percepito selfie → galleria a riposo: pochi secondi; con la coda piena dipende da quanti `index` sono già dentro il semaforo (al massimo 2, quindi < 1 s di attesa).

**Disco.** Originali 1,2 TB + derivati 70 GB + Postgres ~10 GB (vettori e indici compresi) + log: 2 TB dati lasciano ~600 GB di margine. `BACKUP_DIR` su un secondo disco della stessa taglia: copia speculare del bucket + 7 dump da ~10 GB. `MINIO_DATA_DIR` sul disco grande se non è quello di `/var/lib/docker`.

**RAM.** `face-service` ~1 GB residente (limite 4 GB), Postgres 4 GB di `shared_buffers` + cache, MinIO ~2 GB, Node ~1 GB a processo × 5: 32 GB stanno larghi, 16 GB stanno stretti con i parametri ridotti.

**Backup.** `pg_dump -Fc` giornaliero alle `BACKUP_AT` (03:30 UTC), 7 copie; `mc mirror --remove` del bucket. Durante l'evento il mirror sposta ~400 GB/giorno di nuovi originali: a 200 MB/s di disco sono ~35 minuti, di notte. `BACKUP_DIR/last-ok` dice quando è finito l'ultimo.

**Costo (Hetzner, indicativo 2026, IVA esclusa, da `deploy/README.md` §10):** CCX33 (8 vCPU dedicate, 32 GB) ~60 €/mese o CCX43 (16 vCPU, 64 GB) ~120; volume 2 TB ~100; Storage Box 5 TB ~13 (o secondo volume 2 TB ~100); traffico incluso; posta 0–25; dominio ~1. **~175–260 €/mese per il mese dell'evento**; con un dedicato `AX` con NVMe locali 70–90 €/mese senza snapshot del provider. Dopo l'evento si cancella il VPS e si tiene solo il backup. Nessun costo per chiamata di riconoscimento (Rekognition da sola valeva ~160 USD per 150k foto più le ricerche).

## 4. Rete in sala

Due flussi diversi, da tenere su reti diverse.

**Fotografi (upload).** 1,2 TB in 3 giorni, caricati nelle pause: se l'upload avviene tutto in sala in ~10 ore utili al giorno sono ~11 MB/s medi, cioè ~90 Mbit/s **in upload** sostenuti, con picchi oltre il doppio quando 12 persone scaricano la scheda insieme. Serve:

- un uplink **cablato** dedicato ai fotografi, ≥ 100 Mbit/s simmetrici (meglio 200–300 in upload), separato dal Wi-Fi dei partecipanti;
- nessun proxy che tronchi connessioni lunghe: ogni parte multipart è 8 MiB su URL firmato verso `media.DOMAIN` (Caddy → MinIO, `response_header_timeout 120s` su quel sito);
- piano B: upload dall'albergo la sera. L'uploader riprende i file falliti (dedupe locale in IndexedDB, «Riprova tutti») e l'API rifiuta i duplicati con `409`, quindi un trasferimento interrotto non crea doppioni.

Con «Prima il web» i 90 Mbit/s servono solo per gli originali, che possono seguire a ritmo più basso e anche fuori sala; la parte che deve arrivare subito (12.000 foto/ora × ~400 KB ≈ 1,3 MB/s, ~11 Mbit/s) sta in un uplink modesto. L'uploader adatta da solo le connessioni parallele (da 2, tra 1 e 6). Condizione pratica: la scheda (o la cartella del tether) va svuotata nella **cartella sorvegliata** su un PC con Chrome/Edge che resta acceso con la scheda aperta; dopo un riavvio del browser serve un clic su «Riprendi».

**Partecipanti (selfie e galleria).** Un selfie da camera è un JPEG da 1280 px (poche centinaia di KB) più ~5 MB di wasm e modello MediaPipe scaricati dal nostro dominio alla prima apertura di `/selfie` (poi in cache del browser); da file fino a 8 MiB. Una pagina di galleria carica 60 miniature da ~50 KB. Il Wi-Fi dell'evento o la rete mobile bastano. La challenge in camera richiede `https` (o `localhost`): in produzione c'è sempre. Il download ZIP di centinaia di originali va consigliato da casa: non è un problema del server (streaming) ma del Wi-Fi di sala.

**Lato VPS.** Tutto il traffico entra ed esce dalla porta 443 del VPS: upload dei fotografi (~90 Mbit/s), download dei partecipanti (picchi di qualche centinaio di Mbit/s), pagine. Un VPS a 1 Gbit/s regge; un'interfaccia da 100 Mbit/s no.

**Cosa non serve in sala**: nessuna macchina locale, nessun bridge.

## 5. Runbook dei giorni dell'evento

Non c'è CloudWatch: gli strumenti sono `docker compose ps`, i log dei container (`deploy/scripts/logs.sh`), `GET /v1/admin/metrics` dalla pagina `/admin`, uptime-kuma su `status.DOMAIN` e i comandi di sistema (`df -h`, `uptime`, `htop`).

Prima dell'evento (T−1 settimana), tutto da `deploy/README.md` §9:

- [ ] Evento creato con lo slug di `EVENT_SLUG`, `access` deciso (`open` o `list` con import dell'elenco), 12 fotografi invitati e inviti accettati (ognuno in `event_photographers`).
- [ ] Posta: SPF/DKIM/DMARC verificati dal provider, magic link ricevuto da Gmail e Outlook non in spam, `Authentication-Results: spf=pass dkim=pass`.
- [ ] `docker compose ps` tutto `healthy`; `curl -fsS https://DOMAIN/v1/health`; certificato valido; `face-service` `/health` con `model: buffalo_l` (`scripts/logs.sh face-service` mostra `model buffalo_l loaded` e `liveness method: silent-face` o `none`).
- [ ] Decisione su `LIVENESS_CHECK` (`docs/DPIA.md` §10) e, se `true`, prova con un selfie vero e con una foto di una foto.
- [ ] `scripts/backup.sh` eseguito e **prova di ripristino** fatta su un secondo host; `BACKUP_DIR` su disco separato; `df -h` > 1,5 TB liberi sul disco dati.
- [ ] uptime-kuma con monitor su `/v1/health`, `https://media.DOMAIN/minio/health/live`, `/`, e notifiche (Telegram/e-mail) verso chi è in sala.
- [ ] k6 `upload.js` e `selfie.js` (`scripts/loadtest/`) eseguiti contro il VPS con `FACE_ENGINE=insightface`: `time_to_ready` p95 sotto 60 s a riposo.
- [ ] Rete di sala come in §4.

Cosa guardare, ogni ora durante i giorni di upload:

| Segnale | Dove | Normale | Preoccupante | Azione |
| --- | --- | --- | --- | --- |
| `jobsQueued` | `/admin` (`admin/metrics`) | sale durante gli upload, scende a zero in 1–2 ore dopo | non scende mai, o cresce a migliaia per ore | `scripts/logs.sh worker face-service`: righe `ms` lunghe sugli `index` = `face-service` saturo (alzare `FACE_SERVICE_THREADS`/`FACE_SERVICE_CPUS`, `up -d face-service`); `FaceServiceUnavailable` ripetuto = servizio giù (`docker compose restart face-service`) |
| `jobsError`, `photosByStatus.error` | `/admin` | 0, o qualche decina di foto corrotte | cresce di continuo | `scripts/logs.sh worker` campo `error`: `sha256 mismatch` / `unsupported image` = file del fotografo (da ricaricare); `FaceServiceError` con `400`/`413`/`422` = risposta definitiva del `face-service` (immagine non decodificabile o fuori limite), il job fallisce al primo tentativo e la foto va in `error` senza riprovare (non dovrebbe capitare: il worker riduce sotto 5 MB); `Original missing` = upload incompleto |
| `originalsPending` | `/admin`, `uploads/summary` | sale con «prima il web», torna a zero in poche ore | resta alto a fine giornata | un fotografo ha chiuso il browser prima degli originali: riaprire `/upload` e «Riprendi» |
| `docker compose ps` | shell | tutto `healthy` | `unhealthy`, `restarting`, `exited` | `scripts/logs.sh <servizio>`; `face-service` ci mette fino a 2 minuti a caricare il modello (`start_period: 120s`): aspettare prima di riavviare di nuovo |
| Load average | `uptime` | < numero di vCPU | > 2 × vCPU per più di 10 minuti | ridurre `WORKER_CONCURRENCY` a 2 (`up -d worker`): la coda si allunga ma pagine e selfie restano reattivi |
| Disco dati | `df -h` | cresce di ~8 MB a foto | < 10 % libero | spostare i dump vecchi fuori; mai cancellare da `MINIO_DATA_DIR` a mano |
| `BACKUP_DIR/last-ok` | `cat`, o monitor kuma | aggiornato ogni notte | più vecchio di 36 ore | `scripts/logs.sh backup`; disco di backup pieno o smontato |
| Errori SMTP | `scripts/logs.sh api` alla richiesta di un magic link | nessuno | `EAUTH`/`535` credenziali; `ECONNECTION`/timeout host, porta o `SMTP_SECURE`; `4xx` quota del provider | correggere `.env.production`, `up -d api`; con il provider in quota, i partecipanti non entrano: avvisare in sala |
| `429` sui magic link | `scripts/logs.sh access` (status 429 su `/v1/auth/request-link`) | rari | molti dallo stesso IP pubblico | è il NAT del Wi-Fi di sala (20 link/IP/ora): il limite è una costante (`MAGIC_LINK_RATE_LIMIT`, richiede deploy); non alzare `TRUSTED_PROXY_HOPS` |
| `liveness: "rejected"` nei log del worker | `scripts/logs.sh worker` | pochi (solo con `LIVENESS_CHECK=true`) | molti partecipanti veri con «Nessuna corrispondenza» | luce o camera di sala che il modello passivo non gradisce: `LIVENESS_CHECK=false` e `up -d worker` (decisione da annotare nella DPIA) |
| Tempo selfie → galleria | prova in sala | < 1 minuto | minuti | `match` è prioritario: se tarda, il `face-service` è saturo o Postgres è lento (`htop`, `scripts/logs.sh postgres`) |

Cosa fare:

- **Dare CPU al motore.** Non si aggiungono istanze: si alzano `FACE_SERVICE_THREADS` e `FACE_SERVICE_CPUS` (fino al numero di vCPU che si vuole dedicare) e si fa `docker compose --env-file .env.production up -d face-service` (il servizio si ferma ~1–2 minuti per ricaricare il modello; i job `index` in volo falliscono con `FaceServiceUnavailable` e vengono riprovati, i selfie aspettano). Farlo tra una sessione e l'altra.
- **Smaltire la coda la notte.** Non serve fare nulla: `index` e `attach` continuano. Verificare la mattina che `jobsQueued` sia a zero e `photosByStatus.indexed` sia cresciuto del numero di foto caricate il giorno prima.
- **Foto in errore.** `sha256 mismatch` e `unsupported image` da `derive` non si riprovano: il fotografo ricarica il file. Un `DELETE /v1/admin/photos/:id` libera lo sha256 se serve ricaricare lo stesso file. Un `sha256 mismatch` scritto da `verify` non richiede nulla: la foto resta cercabile dal web e l'uploader ripete da solo il secondo stadio.
- **Un fotografo non riesce a caricare (`403` a init).** Non è in `event_photographers`: reinvitarlo dall'`/admin`.
- **Partecipante «non in elenco» (`403` al selfie).** Evento `list`: aggiungere l'e-mail con l'import e far ripetere il selfie.
- **Partecipante senza camera o con la challenge che non passa.** «Usa un file invece» sulla pagina: stesso flusso, `liveness = file` in audit. Se è un caso frequente in una sala buia, è un dato per la DPIA, non un bug.
- **`face-service` che non parte** (`unhealthy` dopo 2 minuti): `scripts/logs.sh face-service`; se manca il modello l'immagine è stata costruita senza rete: `docker compose build face-service` con accesso a GitHub, poi `up -d`.
- **ZIP che si interrompono.** Caddy non ha timeout di risposta sul sito web e 60 s solo sugli header dell'api; uno ZIP lungo dovrebbe reggere. Se cade, è il client o il Wi-Fi: consigliare lo ZIP «Per il web» o selezioni più piccole.
- **Rollback.** `git checkout <tag precedente>` in `/srv/rephoto/app`, `docker compose build && up -d`. Le migrazioni non si annullano da sole: avere il backup della notte (`deploy/README.md` §5).
- **Host che muore.** Nuovo VPS, `bootstrap.sh --no-up`, stesso `.env.production`, copiare `BACKUP_DIR`, `scripts/restore.sh`, DNS sul nuovo IP, `up -d`. È la prova di ripristino della settimana prima, fatta sul serio.

Dopo l'evento:

- [ ] Backup finale (`scripts/backup.sh`), copia di `BACKUP_DIR` fuori dal VPS (cifrata: contiene `face_vectors`).
- [ ] Giorno 90 (o quando deciso): `POST /v1/admin/retention/run` dall'`/admin`; verificare in `audit_log` le righe `photo.deleted` con `retention: true` e che `select count(*) from face_vectors where event_id = …` sia zero.
- [ ] Esportare e conservare quello che il DPO chiede (`docs/DPIA.md` §8), poi purga di `BACKUP_DIR` e delle copie esterne, e cancellazione del VPS.

## 6. Cosa non è stato fatto

Esplicitamente fuori da questa fase o rinviato:

- **Alta disponibilità e autoscaling.** Un host, repliche fisse. Scalare = cambiare `.env.production` e `up -d`. Un secondo `face-service` richiederebbe un bilanciatore davanti (Caddy interno o DNS round-robin di Compose) e non è previsto.
- **Scadenza automatica dei selfie su MinIO.** Il lifecycle a 2 giorni era una regola del bucket AWS; `minio-init` non imposta una regola `ilm`. La cancellazione nel job `match` c'è; manca la rete di sicurezza (`docs/DPIA.md` §10).
- **Cifratura a riposo.** Né Compose né l'app cifrano dischi o colonne: è una scelta a livello di host (LUKS o volume cifrato del provider), da fare prima di caricare dati veri.
- **Rate limiting al bordo.** Caddy di serie non ha `rate_limit`: fail2ban sul log di accesso è documentato, non applicato dallo stack. I limiti dell'api (`MAGIC_LINK_RATE_LIMIT`, `SELFIE_RATE_LIMIT`) sono costanti nel codice.
- **Liveness come prova.** La challenge in camera è asserita dal client; l'anti-spoofing passivo è opzionale, spento di default, non misurato, con pesi senza licenza esplicita. Sono deterrenti (`docs/DPIA.md` §6, §10).
- **App desktop di upload.** Solo dal browser (`/upload`, cartella sorvegliata su Chrome/Edge, PWA).
- **SQS o altra coda.** La coda resta la tabella `jobs`.
- **Retention automatica.** Nessuno scheduler chiama `retention/run`.
- **Revoca self-service del consenso.** Vedi `docs/DPIA.md` §10.
- **Metriche esportate.** `WORKER_PUBLISH_METRICS` è un'esportazione CloudWatch e resta `false`; non c'è un endpoint Prometheus. `admin/metrics` e uptime-kuma sono quello che c'è.

## 7. Verifiche fatte in sviluppo

- `docker compose -f deploy/compose.yml --env-file deploy/.env.production.example config` valida; `Caddyfile` validato con `caddy validate`.
- Prova end-to-end in locale con `FACE_ENGINE=insightface` (`docker compose up -d` dalla radice): 6 volti indicizzati da una foto, il ritaglio del selfie ha trovato solo la propria foto con punteggio 1,0, `/v1/liveness` con `method: silent-face` ha risposto `live: true` sul selfie vero.
- Tempi del `face-service`: ~150–180 ms per foto da 1600 px (Apple silicon, 4 thread), ~325 ms nel container arm64.

## 8. Alternativa AWS (non manutenuta come deploy primario)

Lo stack CDK in `infra/cdk` (`RephotoStack`, aws-cdk-lib v2, `eu-central-1`) resta nel repository e corrisponde al contratto: CloudFront + WAF → ALB → ECS Fargate (api, web, worker con autoscaling su `rephoto/QueueDepth`), RDS PostgreSQL 16 con proxy, S3 privato con KMS e lifecycle `selfies/` 2 giorni, Rekognition via interface endpoint, SESv2, Secrets Manager, allarmi SNS. Lo usa chi sceglie `FACE_ENGINE=rekognition` e `MAIL_TRANSPORT=ses` (`TRUSTED_PROXY_HOPS=2`, `WORKER_PUBLISH_METRICS=true`). Cose da sapere se lo si riprende:

- Le quote Rekognition (`IndexFaces`, `SearchFaces`, `SearchFacesByImage`, storicamente 5 TPS ciascuna in `eu-central-1`) sono per account e vanno chieste **3–4 settimane prima** dell'evento; `REKOGNITION_INDEX_TPS` / `REKOGNITION_SEARCH_TPS` sono per processo e il prodotto con il numero di task deve stare sotto quota. L'`attach` (una `SearchFaces` per volto) è la voce più pesante: ~600.000 chiamate.
- SES va portato fuori dalla sandbox (`docs/ses-produzione.md`).
- CloudFront price class 100 serve pagine e API anche da PoP nordamericani: era un punto aperto della DPIA v3 che la v4 chiude non usando CloudFront.
- Costo: ~350 USD/mese a stack fermo più Rekognition (~160 USD per 150k foto più le ricerche), S3 ed egress (~130 USD per 1,4 TB), Fargate in scala.
- Il runbook v3 (dashboard CloudWatch, allarmi, scaling del worker, ticket quote) è nella storia git di questo file (commit `b45f3b1`).

Lo stack non è stato rideployato con il codice v4: la task definition non conosce le variabili `FACE_*`/`INSIGHTFACE_*` (ignorate con `FACE_ENGINE=rekognition`) e la migrazione `005_face_vectors.sql` su RDS senza pgvector registra solo un `NOTICE`. Funziona, ma non è il percorso verificato.
