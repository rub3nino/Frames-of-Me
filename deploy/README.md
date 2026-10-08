# Frames of Me v4 — installazione self-hosted

Tutto quello che serve per far girare Frames of Me su **un solo VPS Linux** senza AWS: InsightFace al posto di Rekognition, Postgres + pgvector per i vettori, MinIO per le foto, Caddy per TLS e routing, posta via SMTP autenticato verso un provider, backup giornaliero su un secondo disco. La specifica è `docs/v4-selfhost-spec.md`; questo file è il runbook.

Contenuto di `deploy/`:

| File | Cosa fa |
| --- | --- |
| `compose.yml` | lo stack di produzione (vedi § 2) |
| `Caddyfile` | TLS automatico, routing, header di sicurezza, log di accesso |
| `.env.production.example` | ogni variabile commentata; va copiato in `.env.production` |
| `backup/` | immagine del sidecar di backup (`pg_dump` + `mc mirror`) |
| `scripts/bootstrap.sh` | installa Docker su Debian 12 pulito, crea l'utente, clona, configura, avvia |
| `scripts/gen-secrets.sh` | genera password e segreti nel file env |
| `scripts/backup.sh`, `scripts/restore.sh` | backup immediato e ripristino |
| `scripts/migrate.sh` | migrazioni SQL con un container una tantum |
| `scripts/logs.sh` | log dei servizi e log di accesso di Caddy |
| `systemd/rephoto.service` | avvio dello stack al boot |

---

## 1. Dimensionamento per l'evento

Numeri di riferimento (da `docs/infra.md`): 150.000 foto JPEG da ~8 MB in 3 giorni, 12 fotografi, 6.000 partecipanti con picchi di 1.000 selfie in 10 minuti, 3–5 volti per foto (450–750k vettori).

| Risorsa | Minimo | Consigliato | Perché |
| --- | --- | --- | --- |
| vCPU | 8 | 16 | `face-service` (4 thread ONNX, ~150–300 ms per foto da 1600 px), 2 worker × 4 job (resize sharp), 2 api, Postgres |
| RAM | 16 GB | 32 GB | face-service ~2 GB, Postgres 4 GB `shared_buffers` + cache, MinIO ~2 GB, Node ~1 GB a processo |
| Disco dati | 1,5 TB | 2 TB NVMe/SSD | originali ~1,2 TB + derivati ~70 GB + Postgres ~10 GB (vettori 512 float × 750k ≈ 1,5 GB + indice HNSW) |
| Disco backup | 1,5 TB | 2 TB separato | copia del bucket + 7 dump; su Hetzner uno Storage Box o un volume aggiuntivo |
| Rete | 1 Gbit/s | | upload ~90 Mbit/s sostenuti dai fotografi, download degli originali (~1,4 TB in uscita in tre giorni) |

Throughput atteso con la configurazione di default (`FACE_SERVICE_THREADS=4`, `WORKER_REPLICAS=2`, `WORKER_CONCURRENCY=4`): 3–5 foto/s indicizzate, cioè 12.000 foto/ora nel picco di fine sessione **stanno dietro** di qualche decina di minuti e la coda si svuota nell'ora successiva. Con 16 vCPU si può portare `FACE_SERVICE_THREADS=8`, `FACE_SERVICE_CPUS=8` e `WORKER_CPUS=4`. Il `face-service` è un solo processo con un semaforo a 2: non ha senso alzare `WORKER_CONCURRENCY` oltre 4–6 senza dargli più thread.

Postgres: `POSTGRES_SHARED_BUFFERS=4GB`, `POSTGRES_EFFECTIVE_CACHE_SIZE=12GB` sono tarati per 32 GB condivisi; con 16 GB usare `2GB` / `6GB`. `shm_size: 1g` serve ai sort paralleli e alla costruzione dell'indice HNSW.

Connessioni Postgres: api 2 × 10 + worker 2 × 10 + motore facce 4 per processo + backup = ~60 su 200.

---

## 2. Lo stack

```
Internet ──443──▶ caddy ──┬── /v1/*          ──▶ api:8787      (×2)
                          ├── /*             ──▶ web:3000
                          ├── media.DOMAIN   ──▶ minio:9000    (URL firmati, PUT dal browser)
                          └── status.DOMAIN  ──▶ uptime-kuma   (basic auth, opzionale)
                api/worker ──▶ postgres:5432 (pgvector)  ──▶ face-service:8090  ──▶ SMTP provider (AUTH + TLS)
                backup ──▶ postgres + minio ──▶ ${BACKUP_DIR}
```

| Servizio | Immagine | Porte host | Volumi | Note |
| --- | --- | --- | --- | --- |
| `caddy` | `caddy:2-alpine` | 80, 443 (tcp+udp) | `caddy_data` (certificati), `caddy_config`, `caddy_logs` | `Caddyfile` montato in sola lettura |
| `postgres` | `pgvector/pgvector:pg16` | — | `postgres_data` | `shm_size: 1g`, parametri da env |
| `minio` + `minio-init` | `cgr.dev/chainguard/minio` | — | `MINIO_DATA_DIR` (volume o percorso sul disco grande) | `minio-init` crea bucket, policy e utente applicativo, poi termina (§ 6 bis) |
| `face-service` | build `apps/face-service` | — | — | limiti CPU/RAM da env; il modello è nell'immagine |
| `api` ×2 | build `apps/api` | — | — | `/health` |
| `worker` ×2 | build `apps/worker` | — | — | nessuna porta |
| `web` | build `apps/web` | — | — | `NEXT_PUBLIC_*` inlined al build |
| `backup` | build `deploy/backup` | — | `BACKUP_DIR:/backup` | loop giornaliero alle `BACKUP_AT` |
| `uptime-kuma` | `louislam/uptime-kuma:1` | — | `kuma_data` | opzionale |

Tutti i servizi hanno `restart: unless-stopped`, healthcheck e log `json-file` (50 MB × 5). Nessuna porta oltre 80/443 è esposta sull'host: MinIO, Postgres e la console non sono raggiungibili da fuori.

**URL firmati e `media.DOMAIN`.** L'api e il worker parlano con MinIO su `http://minio:9000` (`S3_ENDPOINT`), ma le URL firmate finiscono nel browser, che non risolve `minio`. Per questo l'api firma per `S3_PUBLIC_ENDPOINT=https://media.DOMAIN` (secondo client S3, stesse credenziali) e Caddy fa da reverse proxy trasparente verso `minio:9000`. La firma SigV4 copre l'header `Host`: Caddy lo passa inalterato (`header_up Host {host}` è il comportamento di default, scritto esplicitamente nel `Caddyfile`); non impostare mai `header_up Host {upstream_hostport}` su quel sito. Le URL sono *path-style* (`https://media.DOMAIN/rephoto/thumbs/…`), quindi `MINIO_DOMAIN` resta vuoto e non servono record DNS per `rephoto.media.DOMAIN`. La CORS di MinIO (`MINIO_API_CORS_ALLOW_ORIGIN=https://DOMAIN`) permette la PUT diretta dal browser.

**Immagine web e `NEXT_PUBLIC_*`.** Next.js inlina `NEXT_PUBLIC_EVENT_SLUG`, `NEXT_PUBLIC_MEDIA_ORIGINS` (`https://media.DOMAIN`, finisce nella CSP `img-src`/`connect-src`) e `NEXT_PUBLIC_WEB_ORIGIN` **al build**: `compose.yml` li passa come `build.args` da `.env.production`. Cambiare `DOMAIN` o `EVENT_SLUG` significa `docker compose build web && docker compose up -d web`; riavviare non basta.

**Variabili che arrivano ad api e worker** (tutte da `compose.yml`, `x-app-env`): `NODE_ENV=production`, `DATABASE_URL`, `DATABASE_POOL_MAX`, `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=https://media.DOMAIN`, `S3_BUCKET`, `S3_ACCESS_KEY`/`S3_SECRET_KEY` (= utente applicativo MinIO, **non** root: § 6 bis), `S3_REGION=eu-central-1`, `S3_FORCE_PATH_STYLE=true`, `SESSION_SECRET`, `FACE_ENGINE=insightface`, `FACE_SERVICE_URL=http://face-service:8090`, `INSIGHTFACE_MIN_COSINE`, `INSIGHTFACE_SURE_COSINE`, `INSIGHTFACE_MAX_FACES`, `INSIGHTFACE_MIN_FACE_QUALITY`, `FACE_INDEX_TPS`, `FACE_SEARCH_TPS`, `LIVENESS_CHECK`, `AWS_REGION`, `REKOGNITION_COLLECTION_PREFIX`, `MAIL_TRANSPORT=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `SMTP_STARTTLS`, `SMTP_FROM`, `WEB_ORIGIN`/`API_ORIGIN=https://DOMAIN`, `SEED_DEMO=false`, `TRUSTED_PROXY_HOPS=1`, `WORKER_CONCURRENCY`, `WORKER_PUBLISH_METRICS=false`.

---

## 3. DNS

Quattro record verso l'IP del VPS (A e, se c'è, AAAA):

| Nome | Uso |
| --- | --- |
| `DOMAIN` | app (web + api) |
| `www.DOMAIN` | redirect a `DOMAIN` |
| `media.DOMAIN` | MinIO dietro Caddy (URL firmate) |
| `status.DOMAIN` | uptime-kuma (omettere se disattivato) |

Più i record del provider di posta (§ 8). Caddy ottiene i certificati Let's Encrypt al primo accesso: i record devono essere attivi **prima** di avviare lo stack, altrimenti si accumulano tentativi falliti (rate limit di Let's Encrypt: 5 fallimenti/ora per host).

---

## 4. Primo deploy

Su un VPS Debian 12 (o Ubuntu 22.04+) appena creato, come root:

```sh
curl -fsSL https://raw.githubusercontent.com/<org>/rephoto/main/deploy/scripts/bootstrap.sh \
  | sudo bash -s -- --repo https://github.com/<org>/rephoto.git \
      --domain rephoto.example.com --email ops@example.com --no-up
```

`bootstrap.sh` installa Docker + Compose, crea l'utente `rephoto`, clona in `/srv/rephoto/app`, copia `.env.production.example` in `.env.production`, genera i segreti (`gen-secrets.sh` stampa **una volta** la password di `status.DOMAIN`), installa l'unità systemd e apre 22/80/443 su ufw. Con `--no-up` si ferma prima di costruire le immagini. Poi:

1. Montare il disco di backup e impostare `BACKUP_DIR` (es. `/mnt/backup/rephoto`); se gli oggetti vanno su un disco diverso da `/var/lib/docker`, impostare `MINIO_DATA_DIR=/mnt/data/minio`.
2. Compilare in `.env.production` le righe `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (§ 8) ed `EVENT_SLUG`.
3. `docker compose --env-file .env.production config > /dev/null` (nessun errore = file completo).
4. Build e avvio:

```sh
cd /srv/rephoto/app/deploy
docker compose --env-file .env.production build      # face-service scarica il modello (~300 MB)
sudo systemctl start rephoto
docker compose --env-file .env.production ps          # tutti `healthy` entro ~2 minuti
curl -fsS https://rephoto.example.com/v1/health
```

5. Creare l'evento e l'admin: l'immagine non inserisce dati demo (`SEED_DEMO=false`). Il primo admin si crea con una riga SQL (`insert into users (email, role) values ('admin@…', 'admin')`) via `docker compose exec postgres psql -U rephoto`; poi dall'`/admin` si crea l'evento con lo slug di `EVENT_SLUG` e si invitano i fotografi.
6. Provare il flusso completo (magic link, upload di una foto, selfie, galleria) e un `scripts/backup.sh`.

Senza `bootstrap.sh` (host già configurato): clonare, `cp .env.production.example .env.production`, `scripts/gen-secrets.sh`, compilare il file, `docker compose build && docker compose up -d`, copiare `systemd/rephoto.service` in `/etc/systemd/system/` adattando i percorsi.

---

## 5. Aggiornamento

```sh
cd /srv/rephoto/app
git pull --ff-only
cd deploy
docker compose --env-file .env.production build
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps
```

`up -d` ricrea solo i container la cui immagine o configurazione è cambiata. **Le migrazioni SQL NON partono da sole**: né api né worker le applicano all'avvio, e in `deploy/compose.yml` non c'è un servizio `migrate`. Vanno lanciate a mano con `deploy/scripts/migrate.sh`, **tra `build` e `up`** — altrimenti i container salgono su uno schema vecchio. (`migrate()` prende un lock advisory, quindi lanciarlo due volte in parallelo è innocuo.) Rollback: `git checkout <tag precedente>` e di nuovo build + up (le migrazioni non si annullano da sole: avere un backup appena fatto). Impostare `IMAGE_TAG` allo sha del commit se si vuole tenere le immagini precedenti sul disco.

---

## 6. Backup e ripristino

Il servizio `backup` ogni giorno alle `BACKUP_AT` (UTC) fa `pg_dump -Fc` in `BACKUP_DIR/postgres/rephoto-<data>.dump` (ne tiene `BACKUP_KEEP_DAYS`, 7) e `mc mirror --remove` del bucket in `BACKUP_DIR/objects/rephoto/` (una copia, aggiornata; le foto cancellate dall'admin spariscono dalla copia al giro successivo). `BACKUP_DIR/last-ok` ha l'ora dell'ultimo backup riuscito: metterlo sotto controllo in uptime-kuma o in un cron che avvisa se è più vecchio di 36 ore.

- Backup subito: `scripts/backup.sh`.
- Ripristino: `scripts/restore.sh [nome-dump]` (default: l'ultimo). Ferma api e worker, `pg_restore --clean` nel database esistente, rimanda gli oggetti nel bucket (additivo), riavvia.

Il disco di backup deve essere **fisico/logico diverso** da quello dei dati (volume aggiuntivo, Storage Box via CIFS/SSHFS, o `rclone` verso un bucket esterno subito dopo `last-ok`). `BACKUP_DIR` sullo stesso disco protegge solo dagli errori umani, non dai guasti.

### Prova di ripristino (restore drill)

**Da fare prima dell'evento, non dopo. Un backup che non è mai stato ripristinato non è un backup.**
La prova va fatta su un **host o progetto compose separato**, mai contro la produzione: `restore.sh`
fa `pg_restore --clean`, cioè *droppa e ricrea ogni tabella* del database di destinazione.

Preparazione: un secondo VPS (o la stessa macchina con `name:` diverso in un compose a parte), una
copia di `.env.production` con `DOMAIN` finto, e una copia di `BACKUP_DIR` (`rsync -a` dal disco di
backup, oppure il disco rimontato in sola lettura e copiato).

```sh
# 1. solo i servizi di dato sull'host di prova
cd /srv/rephoto-drill/app/deploy
docker compose --env-file .env.drill up -d postgres minio minio-init
docker compose --env-file .env.drill ps          # postgres e minio `healthy`

# 2. il database di destinazione deve essere VUOTO (è la prova che il dump basta da solo)
docker compose --env-file .env.drill exec -T postgres \
  psql -U rephoto -d rephoto -tAc \
  "select count(*) from pg_tables where schemaname='public'"      # atteso: 0

# 3. ripristino: dump Postgres + mirror degli oggetti nel bucket
docker compose --env-file .env.drill up -d backup
./scripts/restore.sh --yes                        # oppure --yes rephoto-20261007-033000.dump
```

Controlli, nell'ordine (se uno fallisce il backup non è utilizzabile e va sistemato subito):

```sh
D="docker compose --env-file .env.drill exec -T postgres psql -U rephoto -d rephoto -tAc"

# a. le righe ci sono tutte: confrontare con gli stessi conteggi presi in produzione
$D "select (select count(*) from photos) || ' foto, '
        || (select count(*) from galleries) || ' gallerie, '
        || (select count(*) from gallery_items) || ' item, '
        || (select count(*) from users) || ' utenti'"

# b. le migrazioni sono nel dump (api/worker non devono riapplicarne nessuna)
$D "select count(*) || ' migrazioni, ultima=' || max(id) from schema_migrations"

# c. pgvector e gli indici HNSW sono sopravvissuti (sono nel dump, non si ricreano da soli)
$D "select extname || ' ' || extversion from pg_extension where extname='vector'"
$D "select indexname from pg_indexes where indexdef like '%hnsw%' order by indexname"

# d. gli indici di paginazione della 014 ci sono (altrimenti l'admin va in seq scan)
$D "select indexname from pg_indexes where indexname like '%_ms_idx' order by indexname"

# e. una pagina keyset usa ancora l'indice
docker compose --env-file .env.drill exec -T postgres psql -U rephoto -d rephoto -c \
  "explain (costs off) select id from photos
     order by date_trunc('milliseconds', created_at, 'UTC') desc, id desc limit 51"

# f. gli oggetti: numero e dimensione totale uguali alla copia di backup
docker compose --env-file .env.drill exec -T minio \
  /usr/bin/mc du local/rephoto

# g. l'applicazione: avviare il resto e aprire una galleria con le miniature
docker compose --env-file .env.drill up -d api worker web
curl -fsS http://localhost:8787/health
#    poi, da browser, login di un partecipante noto e verifica che le foto si vedano
#    (le miniature sono URL firmate: se compaiono, api, MinIO e il database concordano)
```

Alla fine: `docker compose --env-file .env.drill down -v` sull'host di prova.

**Tempi misurati** (prova eseguita il 2026-10-07 su un Mac arm64 con Docker Desktop, non sull'host
di produzione — servono come ordine di grandezza della parte *database*, non come SLA):

| Passo | Dato | Tempo (3 ripetizioni) |
| --- | --- | --- |
| `pg_dump -Fc --compress=6` | 170.000 righe `photos` + 60.000 `upload_sessions` + 40.000 `match_runs`, database 152 MB | 0,69 / 0,72 / 0,73 s → dump da **19 MB** |
| `pg_restore --clean --if-exists` in un database vuoto | lo stesso dump da 19 MB | 1,02 / 1,04 / 1,06 s |
| `mc mirror` bucket → disco | 600 oggetti, 64 MiB | 0,06–0,39 s (≈ 195 MiB/s) |
| `mc mirror` disco → bucket | 600 oggetti, 64 MiB | ≈ 108 MiB/s |

Esito: conteggi identici, 9 migrazioni presenti (ultima `014_keyset_indexes.sql`), `vector 0.8.7`
con entrambi gli indici HNSW, i quattro indici `*_ms_idx` presenti e la pagina keyset ancora servita
da `photos_event_created_ms_idx`.

**Come estrapolare.** Il tempo del *database* scala con le righe e resta nell'ordine dei minuti:
150.000 foto reali hanno lo stesso ordine di grandezza di metadati di questa prova, ma `face_vectors`
no — un embedding da 512 float per volto è ~2 KB, quindi 150.000 foto × ~3 volti ≈ 900 MB di soli
vettori, e la **ricostruzione degli indici HNSW** durante `pg_restore` è la voce dominante (decine di
minuti, con `maintenance_work_mem=1GB`). Il tempo dell'*object store* è invece una pura copia di
disco: 1,2 TB a 100 MiB/s sono ~3,5 ore, ed è questo a dettare il tempo di ripristino reale. Chi fa
la prova prima dell'evento deve rimisurare **sull'host di produzione e con i dati veri**: i numeri
qui sopra non sostituiscono quella misura.

---

## 6 bis. Credenziali MinIO e privilegio minimo

api e worker **non** hanno le credenziali di root di MinIO. Fino alla v5 `compose.yml` passava
`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` come `S3_ACCESS_KEY`/`S3_SECRET_KEY`: le chiavi che stanno
nell'ambiente di quattro processi Node e che firmano ogni URL presigned consegnata a un browser
erano quelle del superutente dell'object store (creare e cancellare bucket, leggere la copia di
backup, aggiungere utenti, cambiare le policy).

Ora `minio-init` esegue `scripts/minio-provision.sh`, che a ogni `up`:

1. crea il bucket se manca;
2. installa la policy `rephoto-app` — solo oggetti **di quel bucket**;
3. crea (o ri-chiavizza) l'utente applicativo `S3_APP_ACCESS_KEY` e gli attacca la policy;
4. (v6 H3, solo se `S3_SELFIE_EXPIRE_DAYS` è valorizzata) aggiunge la regola di lifecycle che
   scade `selfies/*` dopo N giorni, una volta sola — la controlla prima di aggiungerla. Qui la
   variabile non è impostata, quindi il passo viene saltato: la usa solo
   `docker-compose.coolify.yml`, dove la regola esisteva già inline. Il controllo è un `case`
   di shell e non un `grep`: l'immagine `cgr.dev/chainguard/minio` non ha `grep`.

| Variabile | Chi la usa | Perché |
| --- | --- | --- |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `minio` (server), `minio-init`, `backup`, `scripts/reset-event.sh` | amministrazione e backup: `mc mirror` deve elencare tutto il bucket e un ripristino deve riscriverlo |
| `S3_APP_ACCESS_KEY` / `S3_APP_SECRET_KEY` | `api`, `worker` (come `S3_ACCESS_KEY`/`S3_SECRET_KEY`) | leggere, scrivere e cancellare oggetti dentro `S3_BUCKET`, niente altro |

La policy concede `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload`,
`s3:ListMultipartUploadParts` su `arn:aws:s3:::<bucket>/*` e `s3:ListBucketMultipartUploads`,
`s3:GetBucketLocation` sul bucket. **Non** concede `s3:ListBucket`: api e worker indirizzano ogni
oggetto per chiave (`apps/api/src/objects.ts` usa Get/Put/Delete/Head e i comandi multipart, mai un
listing), quindi una chiave applicativa rubata non permette di enumerare il bucket. Niente azione
`admin:*`, niente creazione o cancellazione di bucket, nessun altro bucket.

Verificato il 2026-10-07 contro un MinIO di prova, eseguendo il vero `createS3ObjectStore`: tutte e
16 le operazioni dell'applicazione funzionano con l'utente ristretto (`put`, `head`, `get`,
`stream`, `head`/`get` di una chiave assente che tornano `null`, `presignPut` + PUT dal browser,
`presignGet` + GET dal browser, `createMultipartUpload`, `presignUploadPart` + PUT della parte,
`completeMultipartUpload`, `abortMultipartUpload`, `delete`). Negate come previsto: `MakeBucket`,
`RemoveBucket`, scrittura in un altro bucket, `ListBucket`, `admin user list/add`,
`admin policy ls`, `admin info`, `anonymous set public`. Due dettagli da sapere:

- `mc ls` e `mc stat` **falliscono** con l'utente applicativo perché elencano il prefisso prima di
  leggere: non è un problema (l'applicazione non elenca mai), ma per ispezionare il bucket a mano
  si usa l'alias root.
- MinIO lascia comunque vedere il **nome** del bucket in `ListBuckets` (filtra la lista a quelli
  raggiungibili). Non espone nulla: il nome è già in `S3_BUCKET` nello stesso ambiente.

**Rotazione della chiave applicativa** (nessun fermo del database, ~10 s di 5xx sugli upload):

```sh
# nuovo segreto in .env.production
sed -i "s|^S3_APP_SECRET_KEY=.*|S3_APP_SECRET_KEY=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')|" .env.production
docker compose --env-file .env.production up -d --force-recreate minio-init
docker compose --env-file .env.production up -d --force-recreate api worker
docker compose --env-file .env.production logs --tail 20 minio-init   # "done"
```

`minio-provision.sh` si rifiuta di partire se `S3_APP_ACCESS_KEY` è uguale a `MINIO_ROOT_USER` o se
il segreto è più corto di 8 caratteri, e fallisce il servizio (quindi blocca api e worker, che
dipendono da `minio-init: service_completed_successfully`) se la policy non è stata attaccata.

---

## 7. Monitoraggio e log

- `scripts/logs.sh [servizio]` segue i log; `scripts/logs.sh access` il log di accesso JSON di Caddy.
- `docker compose ps`: colonna `STATUS` con `healthy`/`unhealthy` per ogni servizio.
- `GET https://DOMAIN/v1/health` (503 se Postgres è giù); `GET /v1/admin/metrics` come admin: `jobsQueued`, `jobsRunning`, `jobsError`, `photosByStatus`, `originalsPending`.
- Worker: una riga JSON per job (`{ ts, job, type, ms, outcome }`); `outcome: "requeued"` continuo = face-service saturo.
- **uptime-kuma** su `https://status.DOMAIN` (utente `STATUS_BASIC_AUTH_USER`, password stampata da `gen-secrets.sh`): aggiungere i monitor HTTP su `/v1/health`, `https://media.DOMAIN/minio/health/live`, la pagina `/`, e un monitor "push" o "keyword" su un piccolo endpoint che espone `last-ok` se si vuole il backup. Per disattivarlo: togliere il servizio da `compose.yml` e il blocco `status.{$DOMAIN}` dal `Caddyfile`, poi `up -d --remove-orphans`.
- Spazio disco: `df -h` sul disco dati e su `BACKUP_DIR` ogni mattina dell'evento; `docker system prune -f` toglie le immagini vecchie dopo un aggiornamento.

### fail2ban su Caddy

Caddy di serie non ha `rate_limit`; l'api limita da sé le richieste di magic link, ma per fermare chi insiste su `/v1/auth/*` conviene fail2ban sul log di accesso (JSON in `caddy_logs`, percorso host `docker volume inspect rephoto_caddy_logs`):

```ini
# /etc/fail2ban/filter.d/caddy-auth.conf
[Definition]
failregex = ^.*"remote_ip":"<HOST>".*"uri":"/v1/auth/[^"]*".*"status":(400|401|403|429).*$
datepattern = "ts":{EPOCH}

# /etc/fail2ban/jail.d/caddy-auth.conf
[caddy-auth]
enabled  = true
filter   = caddy-auth
logpath  = /var/lib/docker/volumes/rephoto_caddy_logs/_data/access.log
maxretry = 20
findtime = 10m
bantime  = 1h
banaction = ufw
```

`sudo fail2ban-client reload && sudo fail2ban-client status caddy-auth`. L'IP del client è `remote_ip` perché Caddy è l'edge (nessun proxy davanti; se si mette Cloudflare, vedi il commento in cima al `Caddyfile` e `TRUSTED_PROXY_HOPS`).

---

## 8. Posta: provider SMTP, SPF e DKIM

L'api manda i magic link e l'avviso "galleria pronta" con [nodemailer](https://nodemailer.com): parla **direttamente** con l'endpoint SMTP del provider, si autentica (`SMTP_USER`/`SMTP_PASSWORD`) e cifra la connessione (STARTTLS su 587, TLS implicito su 465). Non c'è nessun Postfix nello stack: niente relay da tenere su, niente coda locale che nasconde gli errori del provider. Il worker riceve le stesse variabili ma oggi non manda posta.

Scegliere un provider transazionale con un piano adeguato ai volumi (6.000 partecipanti × 2–3 e-mail = ~20.000 messaggi in tre giorni, con picchi di 1.000 in 10 minuti): Brevo, Postmark, Mailgun, Amazon SES (solo SMTP, senza il resto di AWS), Resend. Passi:

1. Nel provider: aggiungere il dominio di `SMTP_FROM` (es. `example.com`) e creare credenziali SMTP.
2. DNS del dominio mittente:
   - **SPF**: record TXT su `example.com`, `v=spf1 include:<provider> -all` (il valore `include:` lo dà il provider; se esiste già un record SPF, aggiungere l'`include` a quello, non crearne un secondo).
   - **DKIM**: i record CNAME/TXT che il provider mostra dopo la verifica del dominio (selettore e chiave pubblica).
   - **DMARC**: TXT su `_dmarc.example.com`, `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com` (iniziare con `p=none` se il dominio manda posta anche da altri sistemi).
   - Il provider segnala quando SPF/DKIM risultano verificati; finché non lo sono, i messaggi vanno in spam o vengono rifiutati.
3. In `.env.production`: `SMTP_HOST=smtp.provider`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE=false`, `SMTP_STARTTLS=true`, `SMTP_FROM=Frames of Me <noreply@example.com>`; poi `docker compose up -d api worker`. Con un provider che espone solo la 465 (TLS implicito): `SMTP_PORT=465`, `SMTP_SECURE=true` (è anche il default su quella porta). `SMTP_STARTTLS=auto` (il default del codice) cifra se il server lo offre e resta in chiaro altrimenti: va bene per Mailpit in locale, in produzione tenere `true` così un endpoint sbagliato fallisce invece di mandare le credenziali in chiaro.
4. Prova: richiedere un magic link dalla pagina pubblica e controllare `scripts/logs.sh api` (un errore SMTP — credenziali, quota, TLS — compare lì come eccezione della richiesta) e la cartella spam del destinatario. Gli header `Authentication-Results` del messaggio ricevuto devono riportare `spf=pass dkim=pass`.

**Perché non un Postfix "vero" sul VPS.** Un server di posta che consegna direttamente ai destinatari richiede: IP con reputazione (gli IP dei VPS sono spesso in blocklist dalla nascita), PTR/rDNS corretto, DKIM gestito in casa, feedback loop con Gmail/Microsoft, gestione di bounce e rate limiting per destinatario; Gmail e Outlook limitano o rifiutano in silenzio la posta da IP nuovi che mandano 1.000 messaggi in dieci minuti, cioè esattamente il picco dei selfie. Con un provider la consegna è il suo problema; con 6.000 partecipanti un magic link finito in spam è un partecipante che non entra. L'api parla con il provider in SMTP autenticato e cifrato: non serve nessun hop intermedio.

---

## 9. I giorni dell'evento

Prima (la settimana prima):

- [ ] Evento creato con lo slug di `EVENT_SLUG`, `access` deciso, fotografi invitati (compaiono in `event_photographers`).
- [ ] Prova completa: upload, selfie, galleria, e-mail ricevuta (non in spam) da Gmail e Outlook.
- [ ] `scripts/backup.sh` e prova di ripristino fatte; `BACKUP_DIR` su disco separato; `df -h` > 1,5 TB liberi sul disco dati.
- [ ] uptime-kuma con notifiche (Telegram/e-mail) verso chi è in sala.
- [ ] `docker compose ps` tutto `healthy`; certificati validi (`curl -vI https://DOMAIN 2>&1 | grep expire`).
- [ ] Rete di sala: uplink cablato ≥ 100 Mbit/s simmetrici per i fotografi, separato dal Wi-Fi dei partecipanti (vedi `docs/infra.md` § 4).

Durante:

| Cosa guardare | Normale | Anomalo → cosa fare |
| --- | --- | --- |
| `jobsQueued` (`/v1/admin/metrics`) | sale durante gli upload, torna a zero in 1–2 ore | non scende: `scripts/logs.sh worker face-service`; face-service `unhealthy` → `docker compose restart face-service`; CPU satura → alzare `FACE_SERVICE_THREADS` (richiede `up -d face-service`) |
| `jobsError` | poche unità (foto corrotte) | cresce di continuo: errore ripetuto nei log del worker (`FaceServiceUnavailable` = servizio giù; `Original missing` = upload incompleto) |
| `originalsPending` | sale con "prima il web", torna a zero in poche ore | resta alto a fine giornata: un fotografo ha chiuso il browser, far premere «Riprendi» su `/upload` |
| Disco dati (`df -h`) | cresce di ~8 MB a foto | < 10 % libero: spostare i dump vecchi, mai cancellare da `MINIO_DATA_DIR` a mano |
| `scripts/logs.sh api` (richiesta magic link) | nessun errore SMTP | `EAUTH`/`535`: credenziali; `ECONNECTION`/timeout: host, porta o `SMTP_SECURE` sbagliati; `4xx`: quota del provider |
| Load average | < numero di vCPU | > 2 × vCPU per più di 10 minuti: ridurre `WORKER_CONCURRENCY` a 2 (`up -d worker`), la coda si allunga ma le pagine restano reattive |

Non serve fare nulla la notte: index e attach continuano e la mattina `jobsQueued` deve essere zero. Il worker ha priorità per i job `match` (selfie) rispetto a `index`/`attach`, quindi i partecipanti vengono serviti anche con la coda piena.

Dopo: backup finale (`scripts/backup.sh`), copia di `BACKUP_DIR` fuori dal VPS, poi purge dei dati secondo l'informativa (admin → eliminazione evento) e spegnimento.

---

## 9 bis. Campagna di test

Il server di test è lo stesso stack con un file di override: `compose.test.yml` aggiunge Mailpit
(tutte le e-mail finiscono lì, UI su `mail.DOMAIN` dietro basic auth), accende il registro dei
match (`MATCH_LOG`), i selfie conservati (`KEEP_SELFIES`), gli id nei log (`LOG_IDS`), spegne i
rate limit, porta il face-service a 2 processi con rilevamento 2560/1024, abilita
`pg_stat_statements` e il log delle query oltre 500 ms, allarga i log a 250 MB × 10 e **ferma il
backup** (profilo `backup`). Analisi e motivazioni: `docs/test-readiness.md`; parametri:
sezione «Test campaign» di `.env.production.example`.

```sh
cd /srv/rephoto/deploy
docker compose --env-file .env.production -f compose.yml -f compose.test.yml up -d --build
```

**Dimensionamento.** Non usare gli 8 MB di `docs/infra.md`: misurare la media reale dei JPEG dei
fotografi su un campione (`du -sh campione/ && ls campione | wc -l`); le reflex da 24 MP a qualità
alta stanno a 10–25 MB, quindi 150k foto sono 1,5–3,75 TB. Disco dati = media × foto × 1,1, con
`MINIO_DATA_DIR` sul disco grande. 16 vCPU / 32 GB restano il riferimento: con il rilevamento a
2560/1024 il face-service fa ~12–17k foto/h su 16 vCPU (`FACE_SERVICE_WORKERS=2`,
`FACE_SERVICE_THREADS=4`, `FACE_SERVICE_CPUS=8`), sufficienti per il picco di 12.000/h.

**HTTPS.** La fotocamera del browser richiede un'origine sicura: serve un dominio vero con record
`DOMAIN`, `media.DOMAIN`, `mail.DOMAIN` (e `status.DOMAIN` se si tiene uptime-kuma); Caddy fa il
resto. Alternative: un sottodominio del dominio aziendale puntato al VPS, oppure
`DOMAIN=test.example.com` con un wildcard; `localhost` è sicuro solo sulla macchina stessa.

**Preparare gli utenti** (evento, admin, fotografi, partecipanti con consenso e cookie di sessione
pronti per k6 ed `evaluate.py`), eseguito da una macchina che raggiunge Postgres oppure in un
container una tantum come per l'ingest:

```sh
# in locale (DATABASE_URL in .env)
npm run seed:test -- --event "$EVENT_SLUG" --name "Test 2026" --photographers 12 --participants 200 \
  --admin ops@example.com --out ./seed
# sul VPS
docker compose --env-file .env.production run --rm --no-deps -v /srv/rephoto/scripts:/app/scripts:ro \
  -v /srv/rephoto/seed:/seed --entrypoint node worker --import tsx /app/scripts/seed-test.ts \
  --event "$EVENT_SLUG" --photographers 12 --participants 200 --admin ops@example.com --out /seed
```

Scrive `cookies-photographers.txt`, `cookies-participants.txt`, `cookies-admin.txt`,
`users-<slug>.csv` (e-mail → token, permessi 0600) e `subjects.csv`. L'admin reale entra da
`/staff` (link via Mailpit) o con `BOOTSTRAP_ADMINS`. `--purge-users` cancella gli utenti generati.

**Caricare le foto** con l'importer (`scripts/ingest/README.md`): `--manifest` è obbligatorio se
poi si vuole valutare, `--state` permette di riprendere, `--rate 3.3` simula i 12.000/h
dell'evento, `--synth 10` moltiplica per dieci un set piccolo con volti veri.

**Osservare**: `./scripts/status.sh -i 30 -o /srv/rephoto/status-<run>.csv` in uno `screen`/`tmux`
per tutta la durata del run (coda per tipo ed età del job più vecchio, foto per stato, vettori e
gallerie, job completati nell'intervallo, p50/p95 per tipo da `jobs.duration_ms`, p50/p95 del
face-service da `/metrics`, `docker stats`, `df`, `iostat`, ultimi errori). Il CSV è la serie
storica da mettere in un foglio dopo il run.

**Ripartire da zero**: `./scripts/reset-event.sh <slug>` ferma worker e api, cancella in una
transazione foto/volti/vettori/gallerie/job/upload/registro match dell'evento, rimuove gli
oggetti da MinIO, `vacuum analyze`, riavvia. Gli utenti e l'evento restano. L'alternativa online è
«Reset evento» nella pagina admin (job `reset`).

**Protocollo** (fase D di `docs/test-readiness.md` § 7):

1. Ingest di un set reale (anche 5–10k foto) e misura del throughput con `status.sh`.
2. Null-selfie test (`scripts/eval/null-selfie.md`) ⇒ scelta di `INSIGHTFACE_MIN_COSINE` /
   `INSIGHTFACE_SURE_COSINE`; cambiarle in `.env.production` e `up -d api worker`.
3. 20 volontari × selfie (fotocamera e da file) + etichette su 300–500 foto ⇒
   `scripts/eval/evaluate.py` (precision/recall, FN per dimensione del volto).
4. Foto caricate *dopo* i selfie ⇒ verifica dell'`attach` (coppie `source = attach`).
5. Ripetere con `FACE_DET_SIZE` 640 vs 1024 e `LIVENESS_CHECK` on/off (ogni volta
   `reset-event.sh` + ingest, oppure un secondo evento).
6. Riavvio del face-service con coda piena (`docker compose restart face-service`): la coda deve
   riprendere senza job in `error`.

Tutto con `status.sh` in registrazione e un `report.md` per configurazione.

---

## 10. Costi (esempio Hetzner, prezzi indicativi 2026, IVA esclusa)

| Voce | Scelta | €/mese |
| --- | --- | --- |
| VPS | CCX33 (8 vCPU dedicate, 32 GB, 240 GB) oppure CCX43 (16 vCPU, 64 GB) | ~60 / ~120 |
| Disco dati | Volume 2 TB (NVMe di rete) | ~100 |
| Backup | Storage Box 5 TB (CIFS/SSHFS) o secondo volume 2 TB | ~13 / ~100 |
| Traffico | 20 TB inclusi; 1,4 TB di download degli originali rientrano | 0 |
| Posta | provider transazionale, 20–30k messaggi | 0–25 |
| Dominio + DNS | | ~1 |
| **Totale per un mese di evento** | | **~175–260** |

Con la variante `AX` (server dedicato con NVMe locali da 2 × 1,9 TB) si evita il volume di rete e si sta intorno ai 70–90 €/mese, ma senza snapshot del provider. Dopo l'evento si tiene solo il backup (Storage Box) e si cancella il VPS: nessun costo di Rekognition (che da sola valeva ~160 USD per 150k foto più le ricerche) né di egress S3.

---

## 11. Verifiche fatte in sviluppo

- `docker compose -f deploy/compose.yml --env-file deploy/.env.production.example config` valida.
- `Caddyfile` validato con `caddy validate` nell'immagine `caddy:2-alpine`.
- `apps/api`: `npx tsc --noEmit` e `node --import tsx --test apps/api/test/routes.test.ts` verdi, incluso il test che controlla che le URL firmate usino `S3_PUBLIC_ENDPOINT`.
- v6 G (ritiro del consenso, retention automatica, allarme per e-mail): `pnpm test` verde (247 test, 0 falliti) con `TEST_DATABASE_URL` su un `pgvector/pgvector:pg16` reale, quindi comprese le prove di cancellazione di `packages/db/src/privacy.pg.test.ts`; `docker compose --env-file deploy/.env.production.example -f deploy/compose.yml config` mostra le cinque variabili `RETENTION_*` su api e worker; `pnpm --filter @rephoto/web build` compila la pagina `/i-miei-dati`. Non provato su un host di produzione.

## 11 bis. Retention automatica (v6 G)

**Prima della v6 nessuno lanciava la retention**: il job `retention` funzionava e `/admin` lo accodava, ma in `deploy/` non c'era né cron né timer, quindi il giorno 90 non arrivava mai da solo. Ora lo scheduler sta **dentro il worker**: nessun cron sull'host, niente da installare a mano, niente che si perda spostando il VPS. Vale anche il contrario: **se il worker è spento, la retention non gira** — ed è per questo che c'è l'allarme.

### Come funziona

- a ogni tick (`RETENTION_TICK_SECONDS`, default **300 s**) ogni replica del worker guarda tutti gli eventi e prova a *rivendicare* la finestra corrente;
- la finestra è lunga `RETENTION_WINDOW_HOURS` (default **24 h**) ed è allineata all'epoch in **UTC**: con 24 cambia alle **00:00 UTC**, quindi il job parte al primo tick dopo mezzanotte UTC (circa 5 minuti dopo), non all'ora in cui è stato avviato il container;
- la rivendicazione è una riga in `retention_schedule` (migrazione 015) e riesce **una volta sola per evento per finestra**, anche con `WORKER_REPLICAS=2` che tickano insieme; la chiave di dedupe della coda (`retention:<eventId>`) è la seconda garanzia;
- il job cancella le foto oltre la retention **album per album** (`albums.retention_days` se c'è, altrimenti `events.retention_days`), con i loro template, derivati e originali, e azzera la parte biometrica delle gallerie il cui match è anteriore al cutoff. Dettaglio e conseguenze legali: `docs/DPIA.md` §8 e §8 bis;
- `RETENTION_SCHEDULER=false` lo spegne (chi preferisce un cron esterno che chiami `POST /v1/admin/retention/run`). Lo schermo admin lo dichiara.

| Variabile | Default | Cosa fa |
| --- | --- | --- |
| `RETENTION_SCHEDULER` | `true` | Accende lo scheduler nel worker |
| `RETENTION_WINDOW_HOURS` | `24` | Al massimo un job per evento per finestra |
| `RETENTION_TICK_SECONDS` | `300` | Ogni quanto il worker controlla se c'è una finestra da rivendicare |
| `RETENTION_ALARM_MAIL` | `true` | Manda l'allarme per e-mail (mailer già configurato, nessun trasporto nuovo) |
| `RETENTION_ALARM_EMAIL` | *(vuoto)* | Destinatari, separati da virgola. Vuoto ⇒ ripiega su `BOOTSTRAP_ADMINS` |

### L'allarme per e-mail

Un allarme che nessuno riceve non è un allarme: una retention che si ferma il venerdì tiene dati personali oltre il periodo di conservazione, e `skipped` e `never` sono proprio gli stati che si verificano quando il worker è giù, cioè quando nessuno sta guardando nemmeno i suoi log. Quindi:

- **chi lo riceve**: `RETENTION_ALARM_EMAIL` (lista separata da virgola), altrimenti `BOOTSTRAP_ADMINS`. Con entrambe vuote non parte nulla e il worker logga `alarmMail: "no-recipient"` — configurazione da correggere, non silenzio voluto;
- **quando**: su `failed`, `job_error` e `skipped`. Un `failed` appena accaduto parte subito, gli altri al tick in cui vengono visti (entro `RETENTION_TICK_SECONDS`);
- **quanto spesso**: **una volta per finestra**, non una per tick. Lo stato «già avvisato» sta in `retention_schedule` accanto alla finestra rivendicata (migrazione 015), quindi la soppressione è condivisa dalle repliche del worker **e sopravvive a un riavvio**. Senza questo, a 300 s di tick, sarebbero 288 messaggi identici al giorno: l'indirizzo finirebbe filtrato e l'allarme sarebbe come non averlo. Un motivo **diverso** nella stessa finestra è informazione nuova e parte;
- **quando rientra**: un solo messaggio «retention rientrata», così un problema risolto non resta aperto nella testa di qualcuno. Arriva al primo tick **dopo** un'esecuzione riuscita: l'allarme viene giudicato sullo stato *precedente* alla rivendicazione (altrimenti un `skipped` verrebbe cancellato dalla stessa esecuzione che chiude il buco), quindi arrivare al confine di una finestra in stato cattivo costa un messaggio in più, seguito da quello di rientro;
- **se l'invio fallisce** (SMTP giù) la rivendicazione viene rilasciata e il tick successivo riprova: un singolo singhiozzo del provider non seppellisce l'allarme per una finestra intera;
- la **riga di log** e il **riquadro rosso** su `/admin` → Stato restano identici: sono la diagnosi, la mail è solo la convocazione. `RETENTION_ALARM_MAIL=false` lascia soltanto quei due;
- `never` (evento che lo scheduler non ha ancora raggiunto) **non** viene spedito: è uno stato transitorio, perché lo stesso tick che lo vedrebbe rivendica la finestra. Resta visibile sullo schermo.

**Quello che questa mail non può fare.** Non può arrivare da un processo che non sta girando: se il worker è spento, o il container non parte, nessuno manda niente. Quel caso si vede in due modi, entrambi indiretti: lo stato **`skipped`** al primo avvio successivo (con la sua mail, perché la finestra è passata senza esecuzioni) e il **monitoraggio di disponibilità** dell'host e dei container (§7, uptime-kuma), che è un'altra cosa e non è collegata a questo allarme. Nessun servizio nuovo è stato aggiunto per chiudere il buco, ed è una scelta: la decisione su come sorvegliare l'host è di chi gestisce l'infrastruttura finale. Allo stesso modo **non** c'è un ritentativo automatico del job di retention: i cinque tentativi sono quelli della coda, e cosa fare dopo è una decisione di chi opera, non un ciclo.

### Verificare un'esecuzione

1. **Dallo schermo admin** (il modo normale): `/admin` → **Stato** → riquadro **Retention**. Per ogni evento: ultima esecuzione, prossima finestra, numero di esecuzioni, esito della pianificazione e stato dell'ultimo job. Un riquadro rosso è un allarme: pianificazione `failed`, job in `error`, oppure `skipped` (più di due finestre senza esecuzioni: il worker è stato giù).

2. **Dall'API**, con un cookie di sessione admin:

```bash
curl -s -b "rephoto_session=$TOKEN" https://$DOMAIN/v1/admin/retention/schedule | jq
# {
#   "enabled": true,
#   "windowSeconds": 86400,
#   "events": [ { "slug": "conferenza-2026", "retentionDays": 90,
#                 "lastRunAt": "...", "nextRunAt": "...", "runs": 3,
#                 "outcome": "enqueued", "jobStatus": "done", "alarm": null } ]
# }
```

3. **Dai log del worker** (`deploy/scripts/logs.sh worker`): ogni esecuzione del job lascia la riga JSON `"type":"retention","outcome":"done"` con la durata; un allarme lascia una riga `{"alarm":"retention","reason":"skipped|failed|job_error", ...}`. Grep utile per un controllo rapido:

```bash
docker compose logs --since 48h worker | grep -E '"type":"retention"|"alarm":"retention"'
```

4. **Dal database**, se serve la prova per il DPO:

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select e.slug, s.window_start, s.claimed_at, s.runs, s.last_outcome, s.last_error
     from retention_schedule s join events e on e.id = s.event_id order by e.slug"
# e le cancellazioni che il job ha fatto (attore nullo = scheduler, non una persona):
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select created_at, target, meta from audit_log
     where action = 'photo.deleted' and meta->>'retention' = 'true'
     order by created_at desc limit 10"
# una riga per esecuzione dello scheduler:
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select created_at, target, meta from audit_log where action = 'retention.scheduled'
     order by created_at desc limit 10"
```

5. **Forzare un'esecuzione subito**, senza aspettare la finestra (per una prova o dopo un `skipped`): il bottone **Esegui adesso** nel riquadro Retention, o la rotta `POST /v1/admin/retention/run` con `{ "eventId": "…" }`. Passa dalla stessa coda e dallo stesso job; l'attore dell'audit è l'admin invece di essere nullo, e la finestra dello scheduler non viene consumata.

**Avvertenze.**

- la retention cancella **davvero** foto, originali e template: su un evento appena importato con `retention_days` basso la prima esecuzione può svuotare l'archivio. Controllare `events.retention_days` e `albums.retention_days` prima di accendere lo scheduler su un evento di produzione;
- l'allarme ha un destinatario (sopra) ma **è una e-mail, non una sveglia**: se la posta del provider è in ritardo o il messaggio finisce in spam, nessuno viene svegliato. E non può arrivare se il worker è spento (sopra);
- lo scheduler **non** è stato provato su un VPS di produzione: quanto sopra è verificato in locale (test contro Postgres reale con pgvector e test del worker) e con `docker compose config`.
