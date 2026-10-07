# Infrastruttura di riferimento e runbook dell'evento

Data: 2026-10-07. Sostituisce `docs/aws.md`. Descrive lo stack in `infra/cdk` (`RephotoStack`, aws-cdk-lib v2, una sola region **eu-central-1**) così com'è scritto, i numeri su cui è dimensionato e cosa guardare nei tre giorni della conferenza. Non è una fattura e non è stato applicato da nessuna pipeline: si applica a mano con `cdk deploy` (comandi in `infra/cdk/README.md`).

## 1. Topologia

```
                     Internet
                        │
            ┌───────────▼───────────┐
            │  CloudFront (PC 100)  │  cache disabilitata tranne /_next/static/*
            │  + header X-Origin-   │  HTTP/2+3, TLS se domainName+certificati
            │    Verify             │
            └───────────┬───────────┘
                        │ 443 (o 80 senza dominio)
   ┌────────────────────▼─────────────────────┐ subnet pubbliche (2 AZ)
   │  ALB  + WAF regionale                    │ 403 senza X-Origin-Verify
   │   /v1/*  → api:8787    resto → web:3000  │ rate rule 300/5 min/IP su /v1/auth/*
   └────────┬───────────────────────┬─────────┘ idle timeout 300 s (ZIP, upload)
            │                       │
 ┌──────────▼──────────┐  ┌─────────▼─────────┐  ┌────────────────────┐   subnet private
 │ ECS Fargate api     │  │ ECS Fargate web   │  │ ECS Fargate worker │   "app" (2 AZ,
 │ 1 vCPU / 2 GB       │  │ 0,5 vCPU / 1 GB   │  │ 2 vCPU / 4 GB      │   NAT ×1)
 │ min 2, max 6        │  │ min 2, max 4      │  │ min 1, max 8       │
 │ scala su CPU 60 %   │  │ scala su CPU 60 % │  │ scala su QueueDepth│
 └──────────┬──────────┘  └───────────────────┘  └─────────┬──────────┘
            │                                              │
            │   ┌──────────────────────────────────────────┤
            │   │                                          │
 ┌──────────▼───▼──────┐                       ┌───────────▼───────────┐
 │ RDS Proxy (TLS)     │                       │ Interface endpoint:   │
 └──────────┬──────────┘                       │ ECR, Logs, Monitoring,│
 ┌──────────▼──────────┐  subnet isolate       │ Secrets Manager,      │
 │ RDS PostgreSQL 16   │                       │ Rekognition, SES SMTP │
 │ db.t4g.medium       │                       └───────────────────────┘
 │ single-AZ, gp3      │                       ┌───────────────────────┐
 │ 50→200 GB, KMS      │                       │ Gateway endpoint S3   │
 └─────────────────────┘                       └───────────┬───────────┘
                                                           │
                                               ┌───────────▼───────────┐
   browser ──── URL firmati (30 min) ─────────►│ S3 rephoto-media-     │
   (thumb, web, originali, PUT upload: anche   │ <account>-eu-central-1│
    il web/ da 1600 px reso dal browser)       │                       │
                                               │ privato, KMS, CORS,   │
                                               │ selfies/ scade 2 gg   │
                                               └───────────────────────┘

   SESv2 (API) e CloudWatch PutMetricData escono dal NAT gateway.
   Rekognition: collection rephoto-{eventId}, via interface endpoint.
   Segreti: DATABASE_URL (via proxy, sslmode=require), SESSION_SECRET, X-Origin-Verify.
   Coda: tabella Postgres `jobs`. Nessun SQS.
```

Punti da tenere a mente:

- **Le immagini non passano da CloudFront.** Miniature, versione web e originali sono URL firmati direttamente sul bucket (`NEXT_PUBLIC_MEDIA_ORIGINS` = `https://rephoto-media-<account>-eu-central-1.s3.eu-central-1.amazonaws.com`). Lo ZIP è l'unica immagine che transita da api → ALB → CloudFront.
- **Gli oggetti `web/` possono essere scritti dal browser.** Con l'upload a due stadi (v3, `CONTRACTS.md` → *Two-stage upload*) il fotografo manda prima un JPEG da 1600 px su `web/{photoId}.jpg` con PUT firmato (vincolato a `Content-Length` e `image/jpeg`, massimo 8 MiB) e l'originale dopo; il worker ricava la miniatura dal web e, quando arriva l'originale, lo rilegge una volta (`verify`) per controllare sha256 e dimensione. Un oggetto `web/` scritto dal client non ha `Cache-Control` (quello del worker sì); la CORS del bucket resta la stessa. Fino all'arrivo dell'originale la galleria segna la foto «solo web» e download/ZIP «Originali» servono il derivato web.
- **`TRUSTED_PROXY_HOPS=2`**: CloudFront aggiunge l'IP del client a `x-forwarded-for`, l'ALB aggiunge l'edge. L'ALB manda `/v1/*` all'api senza passare dal proxy Next.js.
- **Un solo NAT gateway** in una sola AZ: è il punto singolo di questa forma. Serve a SESv2 e CloudWatch (nessun gateway endpoint); tutto il resto passa dagli endpoint.
- **RDS single-AZ** e **deletion protection** + removal policy `RETAIN` su RDS, bucket e chiave KMS: `cdk destroy` non li cancella.
- Immagini costruite in locale per `linux/arm64` al deploy (`ecs.ContainerImage.fromAsset` sui tre Dockerfile del repo).
- Il worker pubblica `rephoto/QueueDepth` (numero di job `queued`, Maximum su 1 minuto) ogni 30 s con `WORKER_PUBLISH_METRICS=true`; lo step scaling del worker è −1 sotto 50, +1 da 300, +2 da 1000, +4 da 3000, cooldown 3 minuti.
- Allarmi SNS: `QueueDepth` > 2000 per 15 minuti, 5xx api > 1 % su 5 minuti, CPU RDS > 80 %, connessioni RDS > 360 (80 % di ~450), nessun task worker in esecuzione.
- Variabili fissate dallo stack: `FACE_ENGINE=rekognition`, `REKOGNITION_SEARCH_MAX_FACES=500`, `REKOGNITION_INDEX_TPS=5`, `REKOGNITION_SEARCH_TPS=5`, `WORKER_CONCURRENCY=4`, `DATABASE_POOL_MAX=10`, `MAIL_TRANSPORT=ses`, `SEED_DEMO=false`. Per cambiarle si cambia lo stack e si rideploya (o si modifica la task definition a mano in emergenza, vedi §6).

## 2. Numeri dell'evento

| Grandezza | Valore assunto | Da dove |
| --- | --- | --- |
| Foto | 150.000 JPEG in 3 giorni, media 8 MB | `docs/v2-spec.md` |
| Fotografi | 12, upload da desktop | idem |
| Partecipanti | 6.000, fino a 1.000 selfie in 10 minuti nei picchi | idem, `scripts/loadtest/selfie.js` |
| Storage originali | ~1,2 TB | 150k × 8 MB |
| Derivati | ~70 GB (thumb ~50 KB, web ~400 KB) | stima |
| Volti indicizzati | 450.000–750.000 (3–5 per foto di conferenza) | stima: `MaxFaces` 50 è il tetto, non la media |
| Righe `jobs` | ~470.000 (3 per foto + 2 per selfie); ~620.000 se tutte le foto arrivano a due stadi (4 per foto: `derive`, `index`, `attach`, `verify`). Eliminate 7 giorni dopo `done` | pipeline |
| `gallery_items` | ~200.000 (6.000 gallerie × ~30 foto) | stima |
| Chiamate Rekognition | 150k `IndexFaces` + 450–750k `SearchFaces` (attach) + 6–10k `SearchFacesByImage` | pipeline |

Cosa pesa davvero:

- **`attach` costa più di `index`.** Ogni foto indicizzata genera una `SearchFaces` per volto. Con 4 volti medi sono 600.000 chiamate contro 150.000 `IndexFaces`. Il bucket `REKOGNITION_SEARCH_TPS` è condiviso tra `SearchFaces` e `SearchFacesByImage` (selfie): se l'attach lo satura, i selfie dei partecipanti aspettano in coda (il job `match` ha priorità 0 nel claim, ma il token bucket non distingue).
- **Picco di upload.** 12 fotografi che scaricano la scheda a fine sessione: 12.000 foto in un'ora sono 3,3 foto/s, cioè 3,3 `IndexFaces`/s e ~13 `SearchFaces`/s. Con i default (5 + 5 TPS per istanza worker, una istanza) la coda cresce di ~8 job/s e viene smaltita nelle ore successive. Non è un errore: è ritardo. Vedi §3 per alzare il tetto.
- **CPU del worker.** `derive` (due resize sharp di un JPEG da 8 MB) e il fit sotto 5 MB per Rekognition sono le operazioni CPU. Un task da 2 vCPU regge 1–2 foto/s; 150.000 foto sono ~25–40 ore-task spalmate sui 3 giorni. L'autoscaling su `QueueDepth` porta fino a 8 task; 8 task × 4 job = 32 job in volo. Con le foto a due stadi il `derive` è più leggero (un solo resize, da un JPEG di ~400 KB invece di 8 MB) ma si aggiunge `verify`: una lettura intera dell'originale da S3 e uno sha256 per foto, cioè ~8 MB per foto e, su 150.000 foto, un secondo passaggio sull'intero 1,2 TB. È I/O dal gateway endpoint (nessun costo di egress) e sta in coda a priorità 70, dopo `derive`/`index`: non ritarda la ricerca, allunga la coda la sera.
- **Due stadi: tempo-alla-ricerca e byte sul percorso critico.** Con «Prima il web, poi gli originali» il percorso critico per una foto (byte in rete → `derive` → `index` → `attach`) parte da un JPEG da ~400 KB invece che dall'originale da 8 MB: il tempo tra lo scatto che entra nella cartella e la foto cercabile si dimezza almeno (l'upload di 8 MB a 10 Mbit/s è ~7 s, quello di 400 KB meno di 1 s, e il `derive` fa un resize in meno), e circa il 90 % dei byte (gli originali) esce dal percorso critico e viaggia dopo, quando la coda web è vuota o dall'albergo la sera. Rekognition, l'`attach` e le quote del §3 non cambiano: il numero di `IndexFaces` e `SearchFaces` per foto è lo stesso, arriva solo prima.
- **Connessioni Postgres.** api 6 × 10 + worker 8 × 10 = 140 al massimo, sotto le ~450 di t4g.medium, attraverso il proxy. `prepare: true` fa pinnare le sessioni sul proxy: non è un pool condiviso, è un assorbitore di churn.
- **Egress.** Se ogni partecipante scarica in media 30 originali (240 MB) sono ~1,4 TB di uscita da S3 verso Internet (non da CloudFront). È la voce di costo più sensibile al comportamento reale (§5).

## 3. Quota Rekognition

Le quote `IndexFaces`, `SearchFaces` e `SearchFacesByImage` sono **per account e per region**, in transazioni al secondo. Il valore di default in `eu-central-1` va letto in Service Quotas → Amazon Rekognition prima di assumere qualcosa; storicamente è 5 TPS per ciascuna di queste tre API nelle region secondarie. Il worker applica `REKOGNITION_INDEX_TPS` e `REKOGNITION_SEARCH_TPS` **per processo**: con N task worker il consumo account è N × il valore. Lo stack parte con 5 + 5 e un worker; con 8 worker si arriva a 40 + 40 TPS, ben oltre il default, e il throttle di Rekognition rimette in coda i job (senza consumare tentativi) ma fa girare a vuoto.

Richiesta da fare in Service Quotas, **almeno 3–4 settimane prima** dell'evento (le quote Rekognition passano da un ticket di supporto con valutazione manuale, non da un aumento automatico):

| API | Default (verificare) | Richiesta proposta | Motivo |
| --- | --- | --- | --- |
| `IndexFaces` | 5 TPS | **20 TPS** | 12 fotografi in picco ~3–4 foto/s; margine per smaltire la coda la sera |
| `SearchFaces` | 5 TPS | **50 TPS** | 4 volti per foto × picco upload; è il collo di bottiglia dell'attach |
| `SearchFacesByImage` | 5 TPS | **20 TPS** | 1.000 selfie in 10 minuti sono 1,7 TPS; il margine serve perché condivide il bucket con `SearchFaces` |
| Volti per collection | 20 milioni (default) | nessuna | 750k è lontano |

Dopo l'aumento, impostare gli env in modo che `REKOGNITION_INDEX_TPS × maxWorker ≤ quota IndexFaces` e `REKOGNITION_SEARCH_TPS × maxWorker ≤ min(quota SearchFaces, quota SearchFacesByImage)`. Esempio con le quote sopra e max 8 worker: `REKOGNITION_INDEX_TPS=2`, `REKOGNITION_SEARCH_TPS=2` restano sotto; con max 4 worker si può salire a 5 e 5. Se la quota non arriva in tempo: lasciare 5 + 5, abbassare `maxCapacity` del worker a 1 e accettare il ritardo dell'attach; i selfie restano serviti perché `match` è prioritario nel claim.

Nel ticket indicare: region `eu-central-1`, date dell'evento, volumi (150.000 immagini, ~600.000 volti, 6.000 ricerche per immagine), uso di collection per evento, nessun contenuto non consentito. AWS chiede di solito il caso d'uso in una frase.

## 4. Rete in sala

Due flussi diversi, da tenere su reti diverse.

**Fotografi (upload).** 1,2 TB in 3 giorni, caricati nelle pause: se l'upload avviene tutto in sala in ~10 ore utili al giorno sono ~11 MB/s medi, cioè ~90 Mbit/s **in upload** sostenuti, con picchi oltre il doppio quando 12 persone scaricano la scheda insieme. Serve:

- un uplink **cablato** dedicato ai fotografi, ≥ 100 Mbit/s simmetrici (meglio 200–300 in upload), separato dal Wi-Fi dei partecipanti;
- nessun proxy che tronchi connessioni lunghe: ogni parte multipart è 8 MiB su URL firmato verso S3, l'ALB non è coinvolto nei PUT;
- piano B: upload dall'albergo la sera. L'uploader riprende i file falliti (dedupe locale in IndexedDB, «Riprova tutti») e l'API rifiuta i duplicati con `409`, quindi un trasferimento interrotto non crea doppioni.

Con l'uploader v3 il quadro cambia in meglio sul filo: con «Prima il web» i 90 Mbit/s servono solo per gli originali, che possono seguire a ritmo più basso e anche fuori sala; la parte che deve arrivare subito (12.000 foto/ora × ~400 KB ≈ 1,3 MB/s, ~11 Mbit/s) sta in un uplink modesto. L'uploader adatta da solo le connessioni parallele (da 2, tra 1 e 6, misurando il throughput ogni 5 s e scendendo al primo timeout), quindi non satura la rete di sala a spese dei partecipanti. Condizione pratica: la scheda (o la cartella del tether) va svuotata nella **cartella sorvegliata** su un PC con Chrome/Edge che resta acceso con la scheda aperta (`/upload` tiene il Wake Lock e controlla la cartella ogni 10 s); dopo un riavvio del browser serve un clic su «Riprendi» per riautorizzare la cartella.

**Partecipanti (selfie e galleria).** Un selfie è 1–8 MiB in upload; una pagina di galleria carica 60 miniature da ~50 KB. Il Wi-Fi dell'evento o la rete mobile bastano. Il download ZIP di centinaia di originali (fino a 500 × 8 MB = 4 GB in streaming) va consigliato da casa: non è un problema del server (è in streaming, mai bufferizzato) ma del Wi-Fi di sala.

**Cosa non serve in sala**: nessuna macchina locale, nessun bridge. Tutto il traffico va verso AWS.

## 5. Costo: ordine di grandezza e avvertenze

Riferimento: stima in `infra/cdk/README.md`, circa **350 USD/mese** a stack fermo (Fargate ai minimi, RDS + proxy, NAT, 7 interface endpoint, ALB, WAF, KMS/Secrets/log). Per i giorni dell'evento aggiungere:

| Voce | Stima | Dipende da |
| --- | --- | --- |
| Rekognition | ~160 USD per 150k foto indicizzate, più le ricerche: `SearchFaces` è fatturata come `SearchFacesByImage` per immagine/richiesta; 600k chiamate attach possono costare quanto l'indicizzazione | numero medio di volti per foto |
| S3 storage | 1,3 TB ≈ 30 USD/mese, pro rata per 90 giorni | retention |
| S3 egress | ~0,09 USD/GB verso Internet: 1,4 TB ≈ 130 USD; con download dal 50 % dei partecipanti si dimezza | comportamento reale |
| Fargate in scala | 8 worker × 2 vCPU per le ore di coda piena | picchi di upload |
| CloudFront | pagine, API e ZIP; gli ZIP possono pesare quanto l'egress S3 se i partecipanti li usano molto | uso dello ZIP |
| NAT | traffico SES e CloudWatch, trascurabile; **attenzione** se qualcuno sposta le chiamate Rekognition fuori dall'endpoint | — |

Avvertenze:

- I prezzi vanno rifatti nell'AWS Pricing Calculator prima di ordinare; questa tabella serve a sapere quali righe guardare, non quanto si paga.
- La voce più incerta è l'attach: dipende dal numero medio di volti per foto, che nessuno ha misurato su questo evento. Un campione di 200 foto indicizzate il primo giorno dà il numero.
- Spegnere lo stack tra un evento e l'altro: `cdk destroy` lascia bucket, chiave KMS e RDS (RETAIN); l'RDS fermo costa comunque storage e, dopo 7 giorni di stop, AWS lo riavvia.

## 6. Runbook dei giorni dell'evento

Prima dell'evento (T−1 settimana):

- [ ] Quota Rekognition confermata (§3) e `REKOGNITION_*_TPS` × `maxCapacity` entro quota.
- [ ] SES fuori dalla sandbox (`docs/ses-produzione.md`), mittente verificato, `mailFrom` nello stack.
- [ ] Dominio e certificati (eu-central-1 per l'ALB, us-east-1 per CloudFront) in contesto CDK, DNS su `CloudFrontDomain`.
- [ ] `alarmEmail` sottoscritto e confermato sul topic SNS.
- [ ] Evento creato, `access` deciso (`open` o `list` con import dell'elenco), 12 fotografi invitati e inviti accettati (ognuno deve comparire in `event_photographers`).
- [ ] k6 `upload.js` e `selfie.js` eseguiti contro lo stack (via CloudFront, non via ALB) con `FACE_ENGINE=rekognition`: `time_to_ready` p95 sotto 60 s a riposo.
- [ ] Backup RDS automatico attivo (7 giorni nello stack); snapshot manuale la sera prima.

Cosa guardare, ogni ora durante i giorni di upload (dashboard CloudWatch o `GET /v1/admin/metrics` dalla pagina `/admin`):

| Segnale | Normale | Preoccupante | Azione |
| --- | --- | --- | --- |
| `rephoto/QueueDepth` | sale durante gli upload, scende a zero in 1–2 ore dopo | > 2000 per 15 minuti (allarme), oppure non scende mai | Vedi «scalare il worker» |
| `jobsError` (metrics) | 0, o qualche decina di foto corrotte (`photos.error`) | cresce di continuo, o `jobsRunning` fermo | Leggere i log del worker (`/rephoto/worker`, campo `error`); un errore ripetuto `Rekognition` → quota o IAM; `Original missing` → upload incompleto |
| `photosByStatus.error` | poche unità | centinaia | Guardare `photos.error`: `sha256 mismatch` = client che ha caricato byte diversi da quelli hashati; `unsupported image` = file non immagine. Lo stesso testo `sha256 mismatch` può venire da `verify` (foto a due stadi): in quel caso lo stato resta `indexed`, l'originale è stato scartato e `originalsPending` risale di uno finché l'uploader non lo rimanda |
| `originalsPending` (metrics e `uploads/summary`) | sale durante gli upload «prima il web», torna a zero in poche ore | resta alto a fine giornata | Un fotografo ha chiuso il browser prima degli originali: fargli riaprire `/upload` e premere «Riprendi» sulla cartella (gli originali dovuti sono in IndexedDB e vengono riletti dalla cartella). Finché resta alto, download e ZIP «Originali» servono la versione web per quelle foto |
| 5xx api (ALB `HTTPCode_Target_5XX_Count`) | 0 | > 1 % (allarme) | Log `/rephoto/api`; se coincide con `RdsConnections` alto → pool esaurito |
| Connessioni RDS | < 150 | > 360 (allarme) | Un task sta perdendo connessioni: riavviare il servizio che cresce; non alzare `DATABASE_POOL_MAX` senza contare `task × pool` |
| CPU RDS | < 50 % | > 80 % (allarme) | Quasi sempre `listGalleryPage` o `jobs` senza gli indici di `003_v2.sql`: verificare che la migrazione sia applicata (`schema_migrations`) |
| Task worker in esecuzione | ≥ 1 | 0 (allarme) | Il servizio ha il circuit breaker: un'immagine che crasha al boot viene rollbackata; guardare gli eventi ECS |
| Throttle Rekognition nei log del worker (`outcome: "requeued"`) | raro | continuo | Il prodotto TPS × worker supera la quota: abbassare gli env o `maxCapacity` |
| `time_to_ready` percepito (selfie → galleria) | < 1 minuto | minuti | `match` è prioritario: se tarda, è il bucket `SEARCH_TPS` saturato dall'attach oppure RDS |

Cosa fare:

- **Scalare il worker.** L'autoscaling arriva a 8 da solo. Se la coda non scende e i worker sono già 8: alzare `maxCapacity` nello stack e rideployare (il deploy del worker non interrompe l'api). Prima di farlo verificare che la quota Rekognition regga il nuovo prodotto `TPS × task`; altrimenti si ottengono solo più `requeued`.
- **Alzare i TPS entro quota.** Quando la quota è stata aumentata dopo il deploy: cambiare `REKOGNITION_INDEX_TPS` / `REKOGNITION_SEARCH_TPS` nella task definition del worker (stack e rideploy, o nuova revisione a mano della task definition e update del servizio). Il limite è per processo: dividere la quota per il numero massimo di task.
- **Smaltire la coda la notte.** Non serve fare nulla: l'attach e l'index continuano. Verificare la mattina che `QueueDepth` sia a zero e `photosByStatus.indexed` sia cresciuto del numero di foto caricate il giorno prima.
- **Foto in errore.** `sha256 mismatch` e `unsupported image` da `derive` non si riprovano: il fotografo ricarica il file (lo stato locale dell'uploader lo mostra in errore con «Riprova»). Un `DELETE /v1/admin/photos/:id` libera lo sha256 se serve ricaricare lo stesso file. Un `sha256 mismatch` scritto da `verify` non richiede nulla all'admin: la foto resta cercabile dal web e l'uploader ripete da solo il secondo stadio alla prossima scansione o al «Riprendi».
- **Un fotografo non riesce a caricare (`403` a init).** Non è in `event_photographers`: reinvitarlo dall'`/admin`; con un utente già esistente l'invito lo iscrive subito, senza attendere il clic.
- **Partecipante «non in elenco» (`403` al selfie).** Evento `list`: aggiungere l'e-mail con l'import (una riga basta) e far ripetere il selfie.
- **Troppi link / troppi selfie (`429`).** Limiti 3 link/e-mail/ora, 20/IP/ora, 5 selfie/utente/ora. Su un Wi-Fi di sala con NAT, 20 richieste di link per IP all'ora possono essere poche: se l'allarme sui `429` arriva dallo stesso IP pubblico, la via corretta è il WAF e il valore in `MAGIC_LINK_RATE_LIMIT` (costante nel codice, richiede deploy), non un aumento di `TRUSTED_PROXY_HOPS`.
- **ZIP che si interrompono.** L'ALB ha idle timeout 300 s e CloudFront read timeout 60 s tra un byte e l'altro: uno ZIP che aspetta un oggetto S3 lento per più di 60 s cade. Consigliare lo ZIP «Per il web» (derivati da ~400 KB) oppure selezioni più piccole.
- **Rollback.** I servizi hanno circuit breaker con rollback automatico sul deploy; per tornare a un'immagine precedente basta rideployare il commit precedente.

Dopo l'evento:

- [ ] Giorno 90 (o quando deciso): `POST /v1/admin/retention/run` dall'`/admin`; verificare in `audit_log` le righe `photo.deleted` con `retention: true` e che la collection sia sparita (`aws rekognition list-collections`).
- [ ] Esportare e conservare quello che il DPO chiede (`docs/DPIA.md` §8), poi `cdk destroy` e snapshot finale RDS.

## 7. Cosa non è stato fatto

Esplicitamente fuori da questa fase (`docs/v2-spec.md` §7) o rinviato:

- **Rekognition Face Liveness.** Nessun controllo che il selfie sia una persona viva: serve una sessione server (`CreateFaceLivenessSession`) e il componente Amplify UI nel client. Rischio e piano in `docs/DPIA.md` §10.
- **App desktop di upload.** L'upload è solo dal browser (`/upload`). Dalla v3 la pagina può osservare una cartella (Chrome/Edge, File System Access, scansione ogni 10 s, da 1 a 6 trasferimenti in volo) e installarsi come PWA, quindi «la cartella della scheda che si carica da sola» esiste, ma con i limiti del browser: la scheda deve restare aperta, dopo un riavvio del browser la cartella va riautorizzata con un clic, Safari e Firefox hanno solo il drag-and-drop. Un servizio in background senza browser non esiste.
- **SQS.** La coda resta la tabella `jobs`. L'interfaccia `JobQueue` è il punto di sostituzione; la metrica `QueueDepth` e l'autoscaling andrebbero rifatti su `ApproximateNumberOfMessagesVisible`.
- **WAF con scope CloudFront.** Una web ACL `CLOUDFRONT` vive in us-east-1 e non può stare in questo stack: la regola è sull'ALB, con `X-Forwarded-For` per contare l'IP del visitatore. L'ALB resta raggiungibile da Internet (risponde `403` senza l'header di CloudFront); per chiuderlo del tutto, limitare il security group alla prefix list gestita `com.amazonaws.global.cloudfront.origin-facing`.
- **Multi-AZ RDS e secondo NAT.** Scelte di costo; sono due righe nello stack.
- **Retention automatica.** Nessuno scheduler chiama `retention/run`.
- **Revoca self-service del consenso.** Vedi `docs/DPIA.md` §10.
- **Limiti per IP configurabili senza deploy.** `MAGIC_LINK_RATE_LIMIT` e `SELFIE_RATE_LIMIT` sono costanti in `packages/contracts/src/http.ts`.
