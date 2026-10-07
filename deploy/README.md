# RePhoto v4 — installazione self-hosted

Tutto quello che serve per far girare RePhoto su **un solo VPS Linux** senza AWS: InsightFace al posto di Rekognition, Postgres + pgvector per i vettori, MinIO per le foto, Caddy per TLS e routing, posta via SMTP autenticato verso un provider, backup giornaliero su un secondo disco. La specifica è `docs/v4-selfhost-spec.md`; questo file è il runbook.

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
| `minio` + `minio-init` | `cgr.dev/chainguard/minio` | — | `MINIO_DATA_DIR` (volume o percorso sul disco grande) | `minio-init` crea il bucket e termina |
| `face-service` | build `apps/face-service` | — | — | limiti CPU/RAM da env; il modello è nell'immagine |
| `api` ×2 | build `apps/api` | — | — | `/health` |
| `worker` ×2 | build `apps/worker` | — | — | nessuna porta |
| `web` | build `apps/web` | — | — | `NEXT_PUBLIC_*` inlined al build |
| `backup` | build `deploy/backup` | — | `BACKUP_DIR:/backup` | loop giornaliero alle `BACKUP_AT` |
| `uptime-kuma` | `louislam/uptime-kuma:1` | — | `kuma_data` | opzionale |

Tutti i servizi hanno `restart: unless-stopped`, healthcheck e log `json-file` (50 MB × 5). Nessuna porta oltre 80/443 è esposta sull'host: MinIO, Postgres e la console non sono raggiungibili da fuori.

**URL firmati e `media.DOMAIN`.** L'api e il worker parlano con MinIO su `http://minio:9000` (`S3_ENDPOINT`), ma le URL firmate finiscono nel browser, che non risolve `minio`. Per questo l'api firma per `S3_PUBLIC_ENDPOINT=https://media.DOMAIN` (secondo client S3, stesse credenziali) e Caddy fa da reverse proxy trasparente verso `minio:9000`. La firma SigV4 copre l'header `Host`: Caddy lo passa inalterato (`header_up Host {host}` è il comportamento di default, scritto esplicitamente nel `Caddyfile`); non impostare mai `header_up Host {upstream_hostport}` su quel sito. Le URL sono *path-style* (`https://media.DOMAIN/rephoto/thumbs/…`), quindi `MINIO_DOMAIN` resta vuoto e non servono record DNS per `rephoto.media.DOMAIN`. La CORS di MinIO (`MINIO_API_CORS_ALLOW_ORIGIN=https://DOMAIN`) permette la PUT diretta dal browser.

**Immagine web e `NEXT_PUBLIC_*`.** Next.js inlina `NEXT_PUBLIC_EVENT_SLUG`, `NEXT_PUBLIC_MEDIA_ORIGINS` (`https://media.DOMAIN`, finisce nella CSP `img-src`/`connect-src`) e `NEXT_PUBLIC_WEB_ORIGIN` **al build**: `compose.yml` li passa come `build.args` da `.env.production`. Cambiare `DOMAIN` o `EVENT_SLUG` significa `docker compose build web && docker compose up -d web`; riavviare non basta.

**Variabili che arrivano ad api e worker** (tutte da `compose.yml`, `x-app-env`): `NODE_ENV=production`, `DATABASE_URL`, `DATABASE_POOL_MAX`, `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=https://media.DOMAIN`, `S3_BUCKET`, `S3_ACCESS_KEY`/`S3_SECRET_KEY` (= root MinIO), `S3_REGION=eu-central-1`, `S3_FORCE_PATH_STYLE=true`, `SESSION_SECRET`, `FACE_ENGINE=insightface`, `FACE_SERVICE_URL=http://face-service:8090`, `INSIGHTFACE_MIN_COSINE`, `INSIGHTFACE_SURE_COSINE`, `INSIGHTFACE_MAX_FACES`, `INSIGHTFACE_MIN_FACE_QUALITY`, `FACE_INDEX_TPS`, `FACE_SEARCH_TPS`, `LIVENESS_CHECK`, `AWS_REGION`, `REKOGNITION_COLLECTION_PREFIX`, `MAIL_TRANSPORT=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `SMTP_STARTTLS`, `SMTP_FROM`, `WEB_ORIGIN`/`API_ORIGIN=https://DOMAIN`, `SEED_DEMO=false`, `TRUSTED_PROXY_HOPS=1`, `WORKER_CONCURRENCY`, `WORKER_PUBLISH_METRICS=false`.

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

`up -d` ricrea solo i container la cui immagine o configurazione è cambiata. Le migrazioni SQL partono da sole al boot di api/worker (lock advisory, una sola istanza le applica); per applicarle prima del rollout: `scripts/migrate.sh` tra `build` e `up`. Rollback: `git checkout <tag precedente>` e di nuovo build + up (le migrazioni non si annullano da sole: avere un backup appena fatto). Impostare `IMAGE_TAG` allo sha del commit se si vuole tenere le immagini precedenti sul disco.

---

## 6. Backup e ripristino

Il servizio `backup` ogni giorno alle `BACKUP_AT` (UTC) fa `pg_dump -Fc` in `BACKUP_DIR/postgres/rephoto-<data>.dump` (ne tiene `BACKUP_KEEP_DAYS`, 7) e `mc mirror --remove` del bucket in `BACKUP_DIR/objects/rephoto/` (una copia, aggiornata; le foto cancellate dall'admin spariscono dalla copia al giro successivo). `BACKUP_DIR/last-ok` ha l'ora dell'ultimo backup riuscito: metterlo sotto controllo in uptime-kuma o in un cron che avvisa se è più vecchio di 36 ore.

- Backup subito: `scripts/backup.sh`.
- Ripristino: `scripts/restore.sh [nome-dump]` (default: l'ultimo). Ferma api e worker, `pg_restore --clean` nel database esistente, rimanda gli oggetti nel bucket (additivo), riavvia.
- **Prova di ripristino** (da fare prima dell'evento, non dopo): su un secondo VPS o in locale, stesso `.env.production`, `docker compose up -d postgres minio minio-init backup`, copiare `BACKUP_DIR`, `scripts/restore.sh --yes`, poi `up -d` del resto e controllare che una galleria si apra con le miniature.

Il disco di backup deve essere **fisico/logico diverso** da quello dei dati (volume aggiuntivo, Storage Box via CIFS/SSHFS, o `rclone` verso un bucket esterno subito dopo `last-ok`). `BACKUP_DIR` sullo stesso disco protegge solo dagli errori umani, non dai guasti.

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
3. In `.env.production`: `SMTP_HOST=smtp.provider`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE=false`, `SMTP_STARTTLS=true`, `SMTP_FROM=RePhoto <noreply@example.com>`; poi `docker compose up -d api worker`. Con un provider che espone solo la 465 (TLS implicito): `SMTP_PORT=465`, `SMTP_SECURE=true` (è anche il default su quella porta). `SMTP_STARTTLS=auto` (il default del codice) cifra se il server lo offre e resta in chiaro altrimenti: va bene per Mailpit in locale, in produzione tenere `true` così un endpoint sbagliato fallisce invece di mandare le credenziali in chiaro.
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
