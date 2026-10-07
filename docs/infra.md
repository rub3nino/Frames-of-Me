# Infrastruttura self-hosted e runbook dell'evento

Data: 2026-10-07, aggiornato il 2026-10-08 alla v5 (rilevamento a 2560/1024, `FACE_SERVICE_WORKERS`, strumenti della campagna di test). Sostituisce la versione v3 di questo file, che descriveva lo stack AWS come deploy di riferimento (ora §8). Descrive lo stack in `deploy/compose.yml` così com'è scritto, i numeri su cui è dimensionato e cosa guardare nei tre giorni della conferenza. Le procedure operative (primo deploy, aggiornamento, backup, posta, fail2ban) sono in `deploy/README.md`; la campagna di test (override `compose.test.yml`, `status.sh`, `reset-event.sh`, importer, protocollo) è in `deploy/README.md` §9 bis e in `docs/test-readiness.md`; qui ci sono la topologia, il dimensionamento su CPU e il runbook. Non è una fattura e niente è stato applicato da una pipeline: si installa a mano con `deploy/scripts/bootstrap.sh`.

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
      ┌──────▼──────┐                 │ face-service     │  insightface buffalo_l, CPU, det 2560/1024
      │ backup      │──► BACKUP_DIR   │ N processi × 4   │  2 inferenze per processo (semaforo)
      │ (2° disco)  │                 │ thread ONNX      │  modelli dentro l'immagine, GET /metrics
      └─────────────┘                 │ 4 vCPU/4 GB      │
                                      └──────────────────┘

   api ──SMTP AUTH + STARTTLS──► provider di posta (unica uscita con dati personali)
   Segreti: .env.production (POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, SESSION_SECRET, SMTP_PASSWORD).
   Coda: tabella Postgres `jobs`. Nessun SQS, nessun CDN, nessun servizio gestito.
```

Punti da tenere a mente:

- **Le URL firmate puntano a `media.DOMAIN`.** L'api e il worker parlano con MinIO su `http://minio:9000` (`S3_ENDPOINT`), ma firmano per `S3_PUBLIC_ENDPOINT=https://media.DOMAIN` (secondo client S3, path-style). Caddy inoltra a MinIO con l'`Host` originale: SigV4 copre l'header, quindi la riga `header_up Host {host}` del `Caddyfile` non si tocca. Miniature, versione web, originali e i PUT dei fotografi passano tutti da Caddy sullo stesso host: non c'è più un bucket «fuori».
- **`TRUSTED_PROXY_HOPS=1`**: Caddy è l'unico proxy, scarta gli `X-Forwarded-*` in ingresso e mette l'IP del client. Con Cloudflare o un altro proxy davanti: `trusted_proxies` nel `Caddyfile` e `TRUSTED_PROXY_HOPS=2`.
- **Il `face-service` è un solo container** e `FACE_SERVICE_URL` è un'URL fissa: Compose non lo replica. Dentro girano `UVICORN_WORKERS` processi (= `FACE_SERVICE_WORKERS`, default **1**; sul server di test 2), ciascuno con la propria copia del modello (≈ 1–1,5 GB RSS), `ONNX_THREADS` (= `FACE_SERVICE_THREADS`, default 4) thread per inferenza e al massimo `MODEL_CONCURRENCY` (= `FACE_MODEL_CONCURRENCY`, default **2**) inferenze contemporanee per processo (semaforo nel codice; un secondo semaforo `DECODE_CONCURRENCY` = 4 limita le decodifiche Pillow); le richieste in più aspettano in coda nel processo. Per dargli più CPU si alzano `FACE_SERVICE_WORKERS` (16 vCPU: 2), `FACE_SERVICE_THREADS` e `FACE_SERVICE_CPUS`, tenendo `thread ≈ CPU / (worker × concorrenza)` e `FACE_SERVICE_MEMORY ≈ worker × 1,5 GB + 1 GB`, non il numero di container. Dalla v5 il rilevamento gira su un'immagine ridotta a **2560 px** con input SCRFD **1024** (`FACE_DET_LONG_EDGE`, `FACE_DET_SIZE`; erano 1600/640): costa ≈ 1,6–1,9× per foto ma trova i volti da 60–80 px delle foto di sala (`docs/test-readiness.md` §3). `GET /metrics` del servizio (solo rete interna) dà contatori e p50/p95 per processo.
- **Il worker manda al motore un JPEG di rilevamento reso dall'originale** a 2560 px (`FACE_INDEX_SOURCE=original`, `FACE_DETECT_LONG_EDGE=2560`), non più il derivato web da 1600: un resize in più per foto nel worker (sharp), nessun oggetto in più su MinIO.
- **I vettori stanno nel database dell'app** (`face_vectors`, 512 float32 per volto, indice HNSW `m = 16, ef_construction = 64`, ricerca con `ef_search = max(100, limit)`; dalla v5 anche `galleries.query_embedding`, il vettore del selfie, con il suo indice HNSW). L'`attach` non chiama più un fornitore: per ogni volto di una foto nuova è una query sull'indice `face_vectors` più una su `galleries` (6.000 righe: trascurabile). Niente quote, niente throttle; il costo è CPU di Postgres.
- **Il worker regge l'assenza del motore.** Un `face-service` giù o lento (timeout 60 s) rimette il job in coda senza contare il tentativo; dopo 5 errori di fila l'interruttore sospende `index`/`attach`/`match` per 30 s (una riga `breaker: "open"` nei log) e riprende da solo. `POST /v1/admin/photos/requeue` rimette in pipeline le foto finite in `error` per altre cause. Un heartbeat ogni 2 minuti su `claimed_at` evita che `retention`/`reset` lunghi vengano eseguiti due volte.
- **Nessuna alta disponibilità.** Un host, `restart: unless-stopped`, healthcheck su tutto, `systemd/rephoto.service` al boot, backup giornaliero su secondo disco. Se il VPS muore si ripristina altrove da `BACKUP_DIR` (`deploy/README.md` §6, prova di ripristino prima dell'evento).
- Variabili fissate dallo stack per api e worker: `FACE_ENGINE=insightface`, `FACE_SERVICE_URL=http://face-service:8090`, **`INSIGHTFACE_MIN_COSINE=0.45`, `INSIGHTFACE_SURE_COSINE=0.65`, `INSIGHTFACE_MAX_FACES=500`, `INSIGHTFACE_MIN_FACE_QUALITY=0.3`** (attenzione: `compose.yml` di produzione ha ancora i default **v4** come fallback `${VAR:-…}`, mentre il codice e `compose.test.yml` usano i v5 0.50 / 0.70 / 200 / 0.2; sul VPS di produzione i valori v5 vanno scritti in `.env.production`, altrimenti il motore rileva a 2560 px ma giudica con le soglie v4), `FACE_INDEX_TPS=20`, `FACE_SEARCH_TPS=20`, `LIVENESS_CHECK=false`, `WORKER_CONCURRENCY=4`, `DATABASE_POOL_MAX=10`, `MAIL_TRANSPORT=smtp`, `SMTP_STARTTLS=true`, `SEED_DEMO=false`, `WORKER_PUBLISH_METRICS=false`; `MATCH_LOG`, `KEEP_SELFIES`, `LOG_IDS` restano `false` (li accende solo `compose.test.yml`). Si cambiano in `.env.production` e `docker compose up -d <servizio>`; le `NEXT_PUBLIC_*` del web richiedono `build`, ma lo slug dell'evento è letto a runtime da `/api/config` (`EVENT_SLUG`), quindi un nuovo evento non richiede più il rebuild del web.

## 2. Numeri dell'evento

| Grandezza | Valore assunto | Da dove |
| --- | --- | --- |
| Foto | 150.000 JPEG in 3 giorni, media 8 MB **da verificare**: le reflex da 24 MP a qualità alta stanno a 10–25 MB (`deploy/README.md` §9 bis: misurare la media su un campione) | `docs/v2-spec.md`, `docs/test-readiness.md` §4 |
| Fotografi | 12, upload da desktop | idem |
| Partecipanti | 6.000, fino a 1.000 selfie in 10 minuti nei picchi | idem, `scripts/loadtest/selfie.js` |
| Storage originali | ~1,2 TB a 8 MB; **1,5–3,75 TB** a 10–25 MB | 150k × media reale × 1,1 |
| Derivati | ~70 GB (thumb ~50 KB, web ~400 KB) | stima; il JPEG di rilevamento a 2560 px non viene salvato |
| Volti indicizzati | 450.000–750.000 (3–5 per foto di conferenza) a 1600 px; **di più a 2560 px**, perché entrano le file in fondo (fino a 100 per foto, qualità ≥ 0,2) | stima: misurare con `status.sh` sul set reale |
| `face_vectors` | 750k × ~2 KB ≈ 1,5 GB di heap + indice HNSW (dello stesso ordine); `galleries.query_embedding` 6.000 × 2 KB, trascurabile | pgvector |
| Righe `jobs` | ~470.000 (3 per foto + 2 per selfie); ~620.000 con tutte le foto a due stadi (`derive`, `index`, `attach`, `verify`). Eliminate 7 giorni dopo `done`; `finished_at`/`duration_ms` per ogni riga | pipeline |
| `gallery_items` | ~200.000 (6.000 gallerie × ~30 foto) | stima |
| `match_runs` / `match_hits` | solo con `MATCH_LOG=true` (test): una riga per selfie + fino a 200 hit per selfie ⇒ ~2 M righe per 10k selfie, ~300 MB | test |
| Chiamate al `face-service` | 150k `/v1/embed` (index) + 6–10k `/v1/embed` (selfie) + 6–10k `/v1/liveness` se attivo | pipeline; l'`attach` è SQL |
| Query HNSW | 450–750k+ (`attach`, una per volto su `face_vectors` più una su `galleries`) + 6–10k (`match`) | pipeline |

Cosa pesa davvero:

- **L'indicizzazione è CPU del `face-service`.** Ogni foto è una detection SCRFD a **1024 px** su un'immagine da 2560 px più un passaggio ArcFace per volto (~10 ms l'uno). Misure v5 (`apps/face-service/README.md`): su foto reali da 20 MP, Apple silicon a 4 thread, un processo, **145–176 ms mediana / ~178 ms p95** a 2560/1024 contro 88–101 / ~105 ms a 1600/640, cioè **≈ 1,6–1,9×**; su 4 vCPU x86 aspettarsi 250–450 ms per foto, 2–4 foto/s per processo. Con 2 inferenze in volo per processo e 4 thread l'una, un processo sta tra **3 e 5 foto/s** a ritmo pieno; con `FACE_SERVICE_WORKERS=2` su 16 vCPU **~6–10 foto/s** (12–17k foto/h, il numero di `deploy/README.md` §9 bis), meno con molti volti per scatto, che a 2560 px sono più di prima.
- **Il worker lavora di più per foto.** Oltre a `derive` (thumb e web), `index` rende il JPEG di rilevamento a 2560 px dall'originale (`FACE_INDEX_SOURCE=original`): un terzo resize sharp per foto, dell'ordine di 100–200 ms su un originale da 24 MP. Con le foto a due stadi l'originale non c'è ancora e il rilevamento parte dal web da 1600: più veloce, meno volti piccoli; l'originale arrivato dopo **non** viene re-indicizzato.
- **`attach` non costa più di `index`.** In v3 erano 600.000 chiamate a un fornitore con quota; ora sono 600.000 query HNSW da pochi millisecondi, nello stesso Postgres, più una scansione delle 6.000 righe `galleries` per volto. Il collo di bottiglia dell'`attach` sparisce; resta quello del `derive`/`index` (resize sharp) e dell'`embed`.
- **Picco di upload.** 12 fotografi che scaricano la scheda a fine sessione: 12.000 foto in un'ora sono 3,3 foto/s, sotto la capacità del `face-service` a 2 processi, al limite con uno solo. Con «prima il web» la foto è cercabile pochi secondi dopo l'arrivo del JPEG da 400 KB. `index` ha priorità 40, davanti a `derive` (50): il motore viene alimentato appena c'è un derivato, senza aspettare che la coda dei `derive` si svuoti.
- **CPU del worker.** `derive` (due resize sharp di un JPEG da 8–25 MB, uno solo con le foto a due stadi), il JPEG di rilevamento e il fit sotto 5 MB dei selfie sono le operazioni CPU del worker. 2 worker × 4 job = 8 job in volo, di cui al massimo `worker × 2` dentro il `face-service` nello stesso istante: gli altri stanno in `derive`, `attach`, `verify` o aspettano. `verify` rilegge ogni originale una volta (1,2–3,75 TB dal MinIO locale, I/O di disco, priorità 70: non ritarda la ricerca).
- **Postgres.** Connessioni: api 2 × 10 + worker 2 × 10 + 4 per processo del motore + backup ≈ 60 su 200. `shared_buffers` 4 GB e `effective_cache_size` 12 GB sono tarati per 32 GB condivisi (con 16 GB: 2 GB / 6 GB). L'indice HNSW va tenuto in RAM: con 750k vettori sono ~1,5–3 GB, dentro i 4 GB di `shared_buffers`.
- **Egress.** 30 originali per partecipante (240 MB) sono ~1,4 TB in uscita dal VPS in tre giorni: dentro i 20 TB inclusi di un VPS Hetzner, ma è banda del data center da tenere d'occhio con `vnstat` o il pannello del provider. Lo ZIP è servito in streaming dall'api attraverso Caddy (nessun timeout di risposta sul sito web, 60 s sull'api solo per gli header).

## 3. Dimensionamento su CPU

Target (`deploy/README.md` §1): 8–16 vCPU dedicate, 32 GB, disco dati NVMe/SSD dimensionato sulla **media reale** dei JPEG (2 TB a 8 MB di media; 4 TB a 25 MB), disco backup separato della stessa taglia, 1 Gbit/s.

**Indicizzazione (v5, rilevamento a 2560/1024).** Con un solo processo (`FACE_SERVICE_WORKERS=1`, `FACE_SERVICE_THREADS=4`, `FACE_SERVICE_CPUS=4`, `WORKER_REPLICAS=2`, `WORKER_CONCURRENCY=4`) e il `face-service` a 250–450 ms per foto con 2 inferenze in volo, il tetto teorico è ≈ **3–5 foto/s**, metà della v4: **150.000 foto in ~9–14 ore** di `face-service` saturo, al limite con il picco di 12.000 foto/ora (3,3/s). Il riferimento per l'evento è quindi **16 vCPU con `FACE_SERVICE_WORKERS=2`, `FACE_SERVICE_THREADS=4`, `FACE_SERVICE_CPUS=8`, `FACE_SERVICE_MEMORY=4g`, `WORKER_CPUS=4`**: ≈ 6–10 foto/s (12–17k foto/h), 150.000 foto in **~5–7 ore**, picco assorbito con margine e coda che si svuota nell'ora successiva. Il tetto si raggiunge solo se i worker tengono sempre `2 × worker` job `index` pronti, cioè se `derive` e il resize di rilevamento non li rallentano: con 8 job in volo e foto a due stadi è realistico; con originali da 10–25 MB e tre resize per foto, contare il valore basso della forchetta o alzare `WORKER_CONCURRENCY` a 6. Più thread per inferenza invece di più processi (`FACE_SERVICE_THREADS=8`, un worker) scala peggio su SCRFD a 1024 px. Alzare `WORKER_CONCURRENCY` oltre 4–6 senza dare CPU al `face-service` allunga solo la coda interna del servizio. Per tornare ai costi v4 (perdendo i volti piccoli): `FACE_DET_LONG_EDGE=1600`, `FACE_DET_SIZE=640`, `FACE_DETECT_LONG_EDGE=1600`.

**Ricerche dei partecipanti.** Un `match` è un `/v1/embed` sul selfie (il selfie è piccolo: 1280 px dalla camera, quindi ~100–200 ms, stesso semaforo dell'indicizzazione), opzionalmente un `/v1/liveness` (~160 ms), una query HNSW. 1.000 selfie in 10 minuti sono 1,7/s: dentro la capacità anche con l'indicizzazione in corso, perché `match` ha priorità 0 nel claim del worker e passa davanti a `index`/`attach`. Il token bucket `FACE_SEARCH_TPS=20` per processo non è mai il limite. Tempo percepito selfie → galleria a riposo: pochi secondi; con la coda piena dipende da quanti `index` sono già dentro i semafori (al massimo 2 per processo, quindi < 1 s di attesa). Un selfie rifiutato dai filtri (nessun volto, troppo piccolo, due persone) non fa nessuna ricerca.

**Disco.** Originali 1,2 TB (8 MB) o fino a 3,75 TB (25 MB) + derivati 70 GB + Postgres ~10–15 GB (vettori e indici compresi, di più con `MATCH_LOG`) + log: con 2 TB dati e foto da 8 MB restano ~600 GB di margine; con foto da 24 MP serve il disco da 4 TB. `BACKUP_DIR` su un secondo disco della stessa taglia: copia speculare del bucket + 7 dump da ~10 GB. `MINIO_DATA_DIR` sul disco grande se non è quello di `/var/lib/docker`.

**RAM.** `face-service` ~1–1,5 GB residenti **per processo** (limite `FACE_SERVICE_MEMORY` ≈ worker × 1,5 GB + 1 GB; con 2 processi 4 GB), Postgres 4 GB di `shared_buffers` + cache, MinIO ~2 GB, Node ~1 GB a processo × 5: 32 GB stanno larghi, 16 GB stanno stretti con i parametri ridotti e un solo processo del motore.

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

Non c'è CloudWatch: gli strumenti sono `docker compose ps`, i log dei container (`deploy/scripts/logs.sh`), la sezione **Stato** di `/admin` (`GET /v1/admin/metrics`: foto per stato, coda per tipo con l'età del job più vecchio, ultimi errori, sonda del `face-service`), `deploy/scripts/status.sh` (schermata ogni N secondi + CSV: coda, throughput, p50/p95 per tipo di job da `jobs.duration_ms`, `/metrics` del motore, `docker stats`, `df`, `iostat`), uptime-kuma su `status.DOMAIN` e i comandi di sistema (`df -h`, `uptime`, `htop`). `status.sh` in uno `screen` per tutti e tre i giorni è la serie storica che altrimenti non c'è.

Prima dell'evento (T−1 settimana), tutto da `deploy/README.md` §9:

- [ ] Evento creato con lo slug di `EVENT_SLUG` (dalla v5 anche da `/admin` → Eventi, senza SQL), `access` deciso (`open` o `list` con import dell'elenco), 12 fotografi invitati e inviti accettati (ognuno in `event_photographers`; in alternativa un link emesso da `/admin` → Link di accesso).
- [ ] **`MATCH_LOG`, `KEEP_SELFIES`, `LOG_IDS` assenti o `false` in `.env.production`**, e lo stack avviato **senza** `-f compose.test.yml` (è l'override del server di test: Mailpit al posto del provider, limiti spenti, selfie conservati). `SELFIE_MAX_PER_HOUR` e `MAGIC_LINK_PER_*` ai default; `RATE_LIMIT_EXEMPT_IPS` vuoto o annotato nella DPIA.
- [ ] Posta: SPF/DKIM/DMARC verificati dal provider, magic link ricevuto da Gmail e Outlook non in spam, `Authentication-Results: spf=pass dkim=pass`.
- [ ] `docker compose ps` tutto `healthy`; `curl -fsS https://DOMAIN/v1/health`; certificato valido; `face-service` `/health` con `model: buffalo_l` (`scripts/logs.sh face-service` mostra `model buffalo_l loaded (det_size=1024, det_long_edge=2560, …)` una volta per processo e `liveness method: silent-face` o `none`); `/admin` → Stato con «Face service ok».
- [ ] Soglie decise dalla campagna di test (`INSIGHTFACE_MIN_COSINE` / `SURE`, `docs/test-readiness.md` §7) scritte in `.env.production`; senza misura restano 0,50 / 0,70.
- [ ] Decisione su `LIVENESS_CHECK` (`docs/DPIA.md` §10) e, se `true`, prova con un selfie vero e con una foto di una foto.
- [ ] `scripts/backup.sh` eseguito e **prova di ripristino** fatta su un secondo host; `BACKUP_DIR` su disco separato; `df -h` > 1,5 TB liberi sul disco dati.
- [ ] uptime-kuma con monitor su `/v1/health`, `https://media.DOMAIN/minio/health/live`, `/`, e notifiche (Telegram/e-mail) verso chi è in sala.
- [ ] k6 `upload.js` e `selfie.js` (`scripts/loadtest/`) eseguiti contro il VPS con `FACE_ENGINE=insightface`: `time_to_ready` p95 sotto 60 s a riposo.
- [ ] Rete di sala come in §4.

Cosa guardare, ogni ora durante i giorni di upload:

| Segnale | Dove | Normale | Preoccupante | Azione |
| --- | --- | --- | --- | --- |
| `jobsQueued`, coda per tipo | `/admin` → Stato (`admin/metrics.jobsByType`), `status.sh` | sale durante gli upload, scende a zero in 1–2 ore dopo; `index` davanti a `derive` | non scende mai, o cresce a migliaia per ore; «lavoro più vecchio in attesa» oltre l'ora | `scripts/logs.sh worker face-service`: righe `ms` lunghe sugli `index` = `face-service` saturo (alzare `FACE_SERVICE_WORKERS`/`FACE_SERVICE_CPUS`, `up -d face-service`); `requeued` ripetuti e una riga `breaker: "open"` = servizio giù o lento (`docker compose restart face-service`): i job aspettano senza finire in errore |
| `jobsError`, `photosByStatus.error`, ultimi errori | `/admin` → Stato (`lastErrors`) | 0, o qualche decina di foto corrotte | cresce di continuo | campo `error`: `sha256 mismatch` / `unsupported image` = file del fotografo (da ricaricare); `FaceServiceError` con `400`/`413`/`422` = risposta definitiva del `face-service` (immagine non decodificabile o fuori limite), il job fallisce al primo tentativo e la foto va in `error` senza riprovare; `Original missing` = upload incompleto. Foto in `error` per una causa passata (es. un'interruzione lunga del motore): `POST /v1/admin/photos/requeue { eventId }` le rimette in coda |
| `match: "rejected"` nei log del worker, motivo in `/admin` → Gallerie | `scripts/logs.sh worker`, elenco gallerie (`reason`) | qualche `no_face` / `face_too_small` | molti `face_too_small` o `low_quality` da selfie veri | luce di sala o camera: i filtri (`SELFIE_MIN_FACE_PX`, `SELFIE_MIN_QUALITY`) si abbassano in `.env.production` + `up -d worker`; il partecipante vede comunque il motivo e può riprovare |
| `originalsPending` | `/admin`, `uploads/summary` | sale con «prima il web», torna a zero in poche ore | resta alto a fine giornata | un fotografo ha chiuso il browser prima degli originali: riaprire `/upload` e «Riprendi» |
| `docker compose ps` | shell | tutto `healthy` | `unhealthy`, `restarting`, `exited` | `scripts/logs.sh <servizio>`; `face-service` ci mette fino a 2 minuti a caricare il modello (`start_period: 120s`): aspettare prima di riavviare di nuovo |
| Load average | `uptime` | < numero di vCPU | > 2 × vCPU per più di 10 minuti | ridurre `WORKER_CONCURRENCY` a 2 (`up -d worker`): la coda si allunga ma pagine e selfie restano reattivi |
| Disco dati | `df -h` | cresce di ~8 MB a foto | < 10 % libero | spostare i dump vecchi fuori; mai cancellare da `MINIO_DATA_DIR` a mano |
| `BACKUP_DIR/last-ok` | `cat`, o monitor kuma | aggiornato ogni notte | più vecchio di 36 ore | `scripts/logs.sh backup`; disco di backup pieno o smontato |
| Errori SMTP | `scripts/logs.sh api` alla richiesta di un magic link | nessuno | `EAUTH`/`535` credenziali; `ECONNECTION`/timeout host, porta o `SMTP_SECURE`; `4xx` quota del provider | correggere `.env.production`, `up -d api`; con il provider in quota, i partecipanti non entrano: avvisare in sala |
| `429` sui magic link | `scripts/logs.sh access` (status 429 su `/v1/auth/request-link`) | rari | molti dallo stesso IP pubblico | è il NAT del Wi-Fi di sala (20 link/IP/ora): dalla v5 `MAGIC_LINK_PER_IP` in `.env.production` (`0` = spento) o la rete della sala in `RATE_LIMIT_EXEMPT_IPS`, poi `up -d api` (da annotare in `docs/DPIA.md`); oppure link emessi dal banco con `/admin` → Link di accesso (QR, non passano dal limite); non alzare `TRUSTED_PROXY_HOPS` |
| `liveness: "rejected"` nei log del worker | `scripts/logs.sh worker` | pochi (solo con `LIVENESS_CHECK=true`) | molti partecipanti veri con «Nessuna corrispondenza» | luce o camera di sala che il modello passivo non gradisce: `LIVENESS_CHECK=false` e `up -d worker` (decisione da annotare nella DPIA) |
| Tempo selfie → galleria | prova in sala | < 1 minuto | minuti | `match` è prioritario: se tarda, il `face-service` è saturo o Postgres è lento (`htop`, `scripts/logs.sh postgres`) |

Cosa fare:

- **Dare CPU al motore.** Non si aggiungono container: si alzano `FACE_SERVICE_WORKERS` (processi, ≈ 1,5 GB RAM l'uno), `FACE_SERVICE_THREADS` e `FACE_SERVICE_CPUS` (fino al numero di vCPU che si vuole dedicare) e si fa `docker compose --env-file .env.production up -d face-service` (il servizio si ferma ~1–2 minuti per ricaricare il modello; i job `index`/`attach`/`match` in volo vengono rimessi in coda senza contare il tentativo e l'interruttore li sospende 30 s alla volta finché il servizio non risponde). Farlo tra una sessione e l'altra.
- **Smaltire la coda la notte.** Non serve fare nulla: `index` e `attach` continuano. Verificare la mattina che `jobsQueued` sia a zero e `photosByStatus.indexed` sia cresciuto del numero di foto caricate il giorno prima (il CSV di `status.sh` lo dice senza stare svegli).
- **Foto in errore.** `sha256 mismatch` e `unsupported image` da `derive` non si riprovano: il fotografo ricarica il file. Un `DELETE /v1/admin/photos/:id` libera lo sha256 se serve ricaricare lo stesso file (dalla v5 toglie anche gli anchor che puntavano ai suoi volti). Un `sha256 mismatch` scritto da `verify` non richiede nulla: la foto resta cercabile dal web e l'uploader ripete da solo il secondo stadio. Per errori transitori su molte foto, `POST /v1/admin/photos/requeue`.
- **Un fotografo non riesce a caricare (`403` a init).** Non è in `event_photographers`: reinvitarlo dall'`/admin` → Gestione, o emettergli un link da Link di accesso con ruolo fotografo (lo iscrive all'evento selezionato).
- **Partecipante «non in elenco» (`403` al selfie).** Evento `list`: aggiungere l'e-mail con l'import e far ripetere il selfie.
- **Partecipante senza camera o con la challenge che non passa.** «Usa un file invece» sulla pagina: stesso flusso, `liveness = file` in audit. Se è un caso frequente in una sala buia, è un dato per la DPIA, non un bug.
- **Partecipante con galleria vuota.** La pagina gli dice perché (nessun volto, troppo lontano, sfocato, due persone, «non ci sono ancora foto»). Dal banco: `/admin` → Gallerie, cerca per e-mail, si vede `reason`, gli anchor e i punteggi; «Non ci sono ancora foto» non è un errore: il vettore del selfie è salvato e le foto si agganciano da sole quando arrivano. Una foto sbagliata in galleria: il partecipante la toglie con «Non sono io»; dal banco `/admin/foto/<id>` mostra i volti e i «vicini» con il coseno per capire perché è entrata.
- **Partecipante che chiede «cosa sapete di me».** Dalla v5 la galleria contiene il vettore del suo selfie: `DELETE /v1/admin/galleries/:userId/:eventId` lo azzera lasciando l'account; `DELETE /v1/admin/participants/:id` cancella tutto (`docs/DPIA.md` §8).
- **`face-service` che non parte** (`unhealthy` dopo 2 minuti): `scripts/logs.sh face-service`; se manca il modello l'immagine è stata costruita senza rete: `docker compose build face-service` con accesso a GitHub, poi `up -d`.
- **ZIP che si interrompono.** Caddy non ha timeout di risposta sul sito web e 60 s solo sugli header dell'api; uno ZIP lungo dovrebbe reggere. Se cade, è il client o il Wi-Fi: consigliare lo ZIP «Per il web» o selezioni più piccole.
- **Rollback.** `git checkout <tag precedente>` in `/srv/rephoto/app`, `docker compose build && up -d`. Le migrazioni non si annullano da sole: avere il backup della notte (`deploy/README.md` §5).
- **Host che muore.** Nuovo VPS, `bootstrap.sh --no-up`, stesso `.env.production`, copiare `BACKUP_DIR`, `scripts/restore.sh`, DNS sul nuovo IP, `up -d`. È la prova di ripristino della settimana prima, fatta sul serio.

Dopo l'evento:

- [ ] Backup finale (`scripts/backup.sh`), copia di `BACKUP_DIR` fuori dal VPS (cifrata: contiene `face_vectors`).
- [ ] Giorno 90 (o quando deciso): `POST /v1/admin/retention/run` dall'`/admin`; verificare in `audit_log` le righe `photo.deleted` con `retention: true` e che `select count(*) from face_vectors where event_id = …` sia zero. **La retention non azzera `galleries.query_embedding`** (il vettore del selfie): `select count(*) from galleries where query_embedding is not null` lo dice; per azzerarli serve il reset dell'evento o la cancellazione delle gallerie (`docs/DPIA.md` §10).
- [ ] Esportare e conservare quello che il DPO chiede (`docs/DPIA.md` §8), poi purga di `BACKUP_DIR` e delle copie esterne, e cancellazione del VPS.

## 6. Cosa non è stato fatto

Esplicitamente fuori da questa fase o rinviato:

- **Alta disponibilità e autoscaling.** Un host, repliche fisse. Scalare = cambiare `.env.production` e `up -d`. Un secondo container `face-service` richiederebbe un bilanciatore davanti (Caddy interno o DNS round-robin di Compose) e non è previsto: si scala con `FACE_SERVICE_WORKERS` (processi nello stesso container).
- **Scadenza automatica dei selfie su MinIO.** Il lifecycle a 2 giorni era una regola del bucket AWS; `minio-init` non imposta una regola `ilm`. La cancellazione nel job `match` c'è; manca la rete di sicurezza (`docs/DPIA.md` §10).
- **Cifratura a riposo.** Né Compose né l'app cifrano dischi o colonne: è una scelta a livello di host (LUKS o volume cifrato del provider), da fare prima di caricare dati veri.
- **Rate limiting al bordo.** Caddy di serie non ha `rate_limit`: fail2ban sul log di accesso è documentato, non applicato dallo stack. I limiti dell'api sono dalla v5 variabili d'ambiente (`MAGIC_LINK_PER_EMAIL`, `MAGIC_LINK_PER_IP`, `SELFIE_MAX_PER_HOUR`, `RATE_LIMIT_EXEMPT_IPS`), non più costanti; nessun limite al bordo.
- **Retention del vettore del selfie.** `galleries.query_embedding` sopravvive alla retention delle foto (sopra, e `docs/DPIA.md` §10).
- **Cancellazione dei selfie conservati.** Con `KEEP_SELFIES=true` (solo test) nessun job rimuove gli oggetti `selfies/`: lo fa `reset-event.sh`.
- **Liveness come prova.** La challenge in camera è asserita dal client; l'anti-spoofing passivo è opzionale, spento di default, non misurato, con pesi senza licenza esplicita. Sono deterrenti (`docs/DPIA.md` §6, §10).
- **App desktop di upload.** Solo dal browser (`/upload`, cartella sorvegliata su Chrome/Edge, PWA).
- **SQS o altra coda.** La coda resta la tabella `jobs`.
- **Retention automatica.** Nessuno scheduler chiama `retention/run`.
- **Revoca self-service del consenso.** Vedi `docs/DPIA.md` §10.
- **Metriche esportate.** `WORKER_PUBLISH_METRICS` è un'esportazione CloudWatch e resta `false`; non c'è un endpoint Prometheus dell'app. Il `face-service` ha un `GET /metrics` in testo (solo rete interna, per processo), `admin/metrics` è più ricco (coda per tipo, ultimi errori, sonda del motore), `status.sh` produce il CSV; uptime-kuma resta l'allarme.

## 7. Verifiche fatte in sviluppo

- `docker compose -f deploy/compose.yml --env-file deploy/.env.production.example config` valida (anche con `-f compose.test.yml`); `Caddyfile` validato con `caddy validate`.
- Prova end-to-end in locale con `FACE_ENGINE=insightface` (`docker compose up -d` dalla radice): nella v4, 6 volti indicizzati da una foto, il ritaglio del selfie ha trovato solo la propria foto con punteggio 1,0, `/v1/liveness` con `method: silent-face` ha risposto `live: true` sul selfie vero. Nella v5, **39 foto di 3 persone** indicizzate a 2560/1024 (**52 volti**); il selfie di una di loro ha trovato **13 foto su 13**, tutte giuste, a coseno ≈ 0,92, nessun falso positivo; un selfie senza volto è stato rifiutato con `no_face`; una foto caricata dopo il selfie si è agganciata da sola alla galleria; registro dei match e export CSV verificati.
- Tempi del `face-service` (foto reali da 20 MP, Apple silicon, 4 thread, un processo): 88–101 ms mediana a 1600/640 (v4), **145–176 ms mediana / ~178 ms p95 a 2560/1024** (v5); ~325 ms era il container arm64 a 1600/640.

## 8. Alternativa AWS (non manutenuta come deploy primario)

Lo stack CDK in `infra/cdk` (`RephotoStack`, aws-cdk-lib v2, `eu-central-1`) resta nel repository e corrisponde al contratto: CloudFront + WAF → ALB → ECS Fargate (api, web, worker con autoscaling su `rephoto/QueueDepth`), RDS PostgreSQL 16 con proxy, S3 privato con KMS e lifecycle `selfies/` 2 giorni, Rekognition via interface endpoint, SESv2, Secrets Manager, allarmi SNS. Lo usa chi sceglie `FACE_ENGINE=rekognition` e `MAIL_TRANSPORT=ses` (`TRUSTED_PROXY_HOPS=2`, `WORKER_PUBLISH_METRICS=true`). Cose da sapere se lo si riprende:

- Le quote Rekognition (`IndexFaces`, `SearchFaces`, `SearchFacesByImage`, storicamente 5 TPS ciascuna in `eu-central-1`) sono per account e vanno chieste **3–4 settimane prima** dell'evento; `REKOGNITION_INDEX_TPS` / `REKOGNITION_SEARCH_TPS` sono per processo e il prodotto con il numero di task deve stare sotto quota. L'`attach` (una `SearchFaces` per volto) è la voce più pesante: ~600.000 chiamate.
- SES va portato fuori dalla sandbox (`docs/ses-produzione.md`).
- CloudFront price class 100 serve pagine e API anche da PoP nordamericani: era un punto aperto della DPIA v3 che la v4 chiude non usando CloudFront.
- Costo: ~350 USD/mese a stack fermo più Rekognition (~160 USD per 150k foto più le ricerche), S3 ed egress (~130 USD per 1,4 TB), Fargate in scala.
- Il runbook v3 (dashboard CloudWatch, allarmi, scaling del worker, ticket quote) è nella storia git di questo file (commit `b45f3b1`).

Lo stack non è stato rideployato con il codice v4: la task definition non conosce le variabili `FACE_*`/`INSIGHTFACE_*` (ignorate con `FACE_ENGINE=rekognition`) e la migrazione `005_face_vectors.sql` su RDS senza pgvector registra solo un `NOTICE`. Funziona, ma non è il percorso verificato.
