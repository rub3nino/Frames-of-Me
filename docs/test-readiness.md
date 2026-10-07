# RePhoto — Analisi di prontezza per la campagna di test

Data: 2026-10-08. Stato del codice: `main` (`ae1bfe5`, stack self-hosted v4).
Obiettivo della campagna: caricare decine di migliaia di foto su un server di test, fare molte scansioni (selfie) e verificare che ogni persona riceva **esattamente e solo** le foto in cui compare, osservando il comportamento del sistema.

Questa analisi nasce da tre revisioni indipendenti del codice (precisione del riconoscimento; carico e infrastruttura; strumenti di test) e da due esperimenti eseguiti sulle foto reali in `photo/` con il modello InsightFace in uso. Le evidenze puntano a file e righe del repository.

---

## 1. Sintesi

Il sistema funziona end-to-end, ma **così com'è non supera l'obiettivo "solo le mie foto"** e non permette di *misurare* se lo supera. Cinque problemi pesano più di tutti gli altri:

| # | Problema | Effetto sull'obiettivo | Gravità |
| --- | --- | --- | --- |
| 1 | Soglia di somiglianza 0,45 su ~450k vettori | Falsi positivi attesi per quasi ogni selfie (4–45 a 0,45; 0,5–5 a 0,50; <0,5 a 0,55). Nel gruppo "Le tue foto" (coseno ≥ 0,55) il 5–35 % dei partecipanti vedrebbe almeno una foto altrui | critica |
| 2 | Volti piccoli non rilevati: catena 1600 px → `det_size` 640 | In una foto da 24 MP un volto sotto ~100 px (fila in fondo, foto di sala) **non viene rilevato**; tra 100 e 190 px è rilevato ma scartato dal filtro qualità. Misurato: volto di 80 px non rilevato con le impostazioni attuali, "sicuro" (0,86) a 2560/1024 | critica |
| 3 | Chi scansiona prima che le foto siano caricate non riceverà mai nulla | Gli anchor della galleria nascono solo dai match del momento; con 0 match la galleria resta vuota per sempre, l'`attach` la salta | critica |
| 4 | Un anchor sbagliato contamina la galleria per 3 giorni | Gli anchor sono i 5 migliori match senza soglia dedicata; un impostore a 0,46 diventa anchor e tutte le sue foto future entrano in "Le tue foto" | critica |
| 5 | Nessuno strumento di misura né di osservazione | Non si possono calcolare precision/recall, non si vedono i coseni grezzi, non esiste un importer per caricare foto in massa, un riavvio di 5 minuti del face-service manda in errore permanente tutta la coda | critica |

La buona notizia: nessuno di questi richiede un cambio di architettura. Sono soglie, un paio di scelte nel job `match`/`attach`, una risoluzione di rilevamento più alta e circa dieci giorni di strumenti.

---

## 2. Precisione: "solo le mie foto"

### 2.1 Soglie (`INSIGHTFACE_MIN_COSINE` 0,45 / `SURE` 0,65)
Evidenza: `packages/face-engine/src/insightface.ts:16-17`, mapping 0–100 in `:402-406`; la DPIA ammette che 0,45 «non è un tasso di falso match misurato». ArcFace w600k_r50 su volti "in the wild" ha una coda impostore che a 0,45 rende quasi certo almeno un falso positivo per selfie su 450k candidati; i volti piccoli/sfocati (proprio quelli di sala) producono embedding "medi" che alzano la coda.
Raccomandazione per il test: **MIN 0,50, SURE 0,70** (⇒ "Le tue foto" = coseno ≥ 0,60; "Forse sei tu" = 0,50–0,60) e **misurare** con il null-selfie test (§5). Se si vuole la garanzia "solo le mie", MIN 0,55 accettando qualche foto vera persa.

### 2.2 Anchor e `attach`
Evidenza: `apps/worker/src/handlers.ts:372-373` (anchor = top-5 senza soglia), `:281` (attach accetta coseno ≥ 0,45 anchor↔volto). Gli anchor non si aggiornano mai (nessun drift), ma neppure si arricchiscono.
Raccomandazioni: anchor solo da match con coseno ≥ SURE; soglia separata e più alta per l'attach (`INSIGHTFACE_ATTACH_MIN_COSINE`, es. 0,55); con ≥ 3 anchor richiedere il consenso di almeno 2; lo score mostrato per un attach = min(score anchor↔volto, score anchor↔selfie).

### 2.3 Selfie prima delle foto
Evidenza: `handlers.ts:372-384` (0 hit ⇒ anchor vuoti, selfie cancellato), `packages/db/src/postgres.ts:712-716` (`countAnchoredGalleries`), `handlers.ts:270` (attach salta).
Due strade: (a) conservare per galleria il **vettore del selfie** (`gallery_query_vectors`, 512 float) e usarlo come anchor sintetico — richiede una riga in più nella DPIA (template biometrico a riposo, già vero per `face_vectors`); (b) senza toccare la DPIA, ritentare il `match` differito ogni N ore finché non ci sono anchor, conservando l'oggetto selfie, e dire all'utente "non ci sono ancora foto, ti avviseremo". Consiglio (a): è più semplice, più precisa (il selfie è il confronto migliore) e l'utente non deve rifare nulla. In ogni caso `removeAnchors` va chiamato anche in `purgePhoto` e nel re-index (oggi anchor orfani).

### 2.4 Qualità del selfie
Evidenza: `insightface.ts:192` (volto più grande senza soglia), nessun motivo esposto quando il selfie non ha volti (`handlers.ts:347-383`, UI "Nessuna corrispondenza"). La challenge cattura 3 frame dopo il blink (`apps/web/lib/liveness.ts:287-296`): rischio di motion blur.
Raccomandazioni: rifiutare selfie senza volto, con volto < 120 px, quality < 0,6 o con due volti di area simile; esporre `reason` nella galleria ("nessun volto", "volto troppo piccolo", "nessuna foto ancora"); nella challenge attendere ~300 ms e scegliere il frame più nitido tra 3–5.

### 2.5 Feedback e spiegazione
Nessun "Non sono io", nessuna memoria dei rifiuti al re-scan (`replaceGallery` azzera tutto), nessuno score visibile, nessuna vista dei volti/riquadri. Senza questo l'operatore non può capire *perché* una foto è entrata, e i volontari non possono fornire ground truth.

### 2.6 Coerenza dati
`face_vectors` scritti prima di `faces` (`handlers.ts:241`, `insightface.ts:172`): un errore in mezzo lascia vettori orfani e al retry non vengono puliti; nessuna FK su `photos`; un `index` ri-eseguito dopo il reclaim a 10 minuti duplica i vettori. Fix: `delete from face_vectors where photo_id = $1` prima dell'insert, FK con cascata, riconciliazione periodica.

---

## 3. Recall: i volti piccoli (esperimento sulle tue foto)

Metodo: ritratto reale rimpicciolito e incollato su una tela da 6000×4000 (24 MP) per simulare una foto di sala; confronto dell'embedding con quello a piena risoluzione.

| Volto nell'originale 24 MP | Attuale (1600 px, det 640) | Proposto (2560 px, det 1024) |
| --- | --- | --- |
| 140 px | sicuro (0,90), quality 0,50 | sicuro (0,95) |
| 100 px | match (0,76) **ma quality 0,27 → scartato** | sicuro (0,90) |
| 80 px — fila in fondo | **non rilevato** | sicuro (0,86), quality 0,36 |
| 60 px | **non rilevato** | sicuro (0,77), quality 0,23 |

Tempo per foto: 50–75 ms → 120–170 ms (≈ 2×). Il riconoscimento resta affidabile fino a ~28 px nell'immagine di rilevamento; il filtro `INSIGHTFACE_MIN_FACE_QUALITY = 0,3` scarta volti ancora riconoscibili.

Raccomandazioni: rilevamento su 2560 px con `DET_SIZE=1024` (il servizio oggi riduce sempre a 1600: `apps/face-service/app/images.py:21`, `engine.py:133`); `INSIGHTFACE_MIN_FACE_QUALITY=0,2`; `max_faces` 100 per le foto di gruppo; `min_size` 24 px. Attenzione: più volti piccoli ⇒ più rumore da sfondo; va governato con la soglia (§2.1) e con una frazione minima di area quando si alza la risoluzione. Da verificare nel test con foto di sala vere (la simulazione è ottimistica per il rilevamento).

---

## 4. Robustezza della pipeline sotto carico

| Problema | Evidenza | Fix |
| --- | --- | --- |
| Face-service assente 1–5 min (riavvio, OOM) ⇒ **tutta la coda `index` in errore permanente** (5 tentativi a 30 s × n) | `apps/worker/src/run.ts:101-109` riconosce come throttle solo gli errori Rekognition | trattare `FaceServiceUnavailable` come throttle (requeue senza contare) + rotta/script per rimettere in coda le foto in `error` |
| Priorità `derive` 50 < `index` 60: con 150k derive in coda il face-service resta fermo per ore, poi viene martellato | `packages/contracts/src/jobs.ts:83-91` | `index: 40` |
| Face-service: 1 processo, 2 inferenze; nessun timeout sulla `fetch` | `app/main.py:36,177`, `Dockerfile:42`, `insightface.ts:296-303` | `UVICORN_WORKERS` parametrico (16 vCPU: 2 worker × 4 thread), `AbortSignal.timeout(60 s)`; non contare sul round-robin DNS di Compose |
| Reclaim a 10 minuti senza heartbeat: `retention` (ore) e `index` appesi vengono eseguiti due volte | `jobs.ts:77`, `postgres.ts:975-1005` | heartbeat su `claimed_at` ogni 2–3 min, o soglia per tipo |
| Disco: originali 10–25 MB × 150k = **1,5–3,75 TB** (non 1,2); backup `mc mirror` sullo stesso disco raddoppia lo spazio e satura l'I/O di notte | `README.md:30`, `deploy/backup/rephoto-backup` | misurare la media reale, `MINIO_DATA_DIR` sul disco grande, backup fermo o su disco separato nel test |
| `admin/metrics` fa 13 `count(*)` completi; nessuna serie storica; log worker senza id e con rotazione a 250 MB | `postgres.ts:896-945`, `run.ts:23-34` | `scripts/status.sh` + CSV, `jobs.finished_at/duration_ms`, `LOG_IDS=true`, log più ampi nel test |
| Magic link: invio mail dentro la richiesta, pool 2 connessioni; rate limit 20/IP/ora blocca una sala intera | `apps/api/src/routes.ts:71-93`, `mailer.ts:54`, `http.ts:20` | limiti configurabili (`MAGIC_LINK_PER_EMAIL/PER_IP`, `SELFIE_MAX_PER_HOUR`, IP esenti), link emesso dall'admin, in produzione invio via job `email` |
| Egress: 300 foto × 20 MB per partecipante ⇒ fino a 36 TB se tutti scaricano gli originali | `ZIP_MAX_PHOTOS=500` | ZIP "web" di default, originali solo per selezione |
| `ef_search=500` per ogni ricerca `attach` (600k ricerche) | `insightface.ts:26,241-248` | `INSIGHTFACE_MAX_FACES=200`, limite separato per `searchFaces` (~100) |

Throughput atteso (CPU): 8 vCPU ≈ 11–16k foto/h (150k in 10–14 h); 16 vCPU con 2 processi uvicorn ≈ 25–35k/h (150k in 5–6 h). Con la risoluzione di rilevamento raddoppiata (§3) dimezzare queste cifre: su 16 vCPU restano ~12–17k/h, sufficienti per i 12.000/h di picco dell'evento.

---

## 5. Strumenti mancanti per il test

| Strumento | Perché serve | Stima |
| --- | --- | --- |
| **Importer server-side** `scripts/ingest` (cartella → sha256 → MinIO → `photos` + job, N parallelo, ripresa, `--rate`, `--synth` per moltiplicare foto con volti veri, manifest `filename,sha256,photoId`) | il browser non è lo strumento per 150k foto; il manifest collega le etichette alle foto | 1 g |
| **Registro dei match con coseno grezzo** (`match_runs` + `match_hits`, tutti gli hit anche sotto soglia) oppure `scripts/eval/offline-search.py` (embed del selfie + stessa query SQL del motore) | senza i coseni grezzi non si tarano le soglie | 0,5–1 g |
| **Null-selfie test** (selfie di persone *non* presenti ⇒ ogni hit è un falso positivo ⇒ istogramma impostore reale) | è la misura più informativa, a costo zero | incluso sopra |
| **`evaluate.py`** + `labels.csv` (soggetto, file) + `subjects.csv` + export CSV gallerie: precision/recall per soggetto e globale, istogrammi veri/falsi, sweep di soglia, falsi negativi per dimensione del volto | la risposta numerica alla domanda "trova solo le mie foto?" | 1,5 g |
| **Vista admin**: galleria di un partecipante per email con score; pagina foto con riquadri dei volti, vicini più prossimi con coseno, gallerie in cui sta | l'occhio dell'operatore | 2 g |
| **Rate limit configurabili** + **link di accesso emesso dall'admin** (QR in sala) + **Mailpit nello stack di test** | altrimenti al 21º volontario dalla stessa rete la sala è bloccata; nessun provider SMTP sul test box | 0,5 g |
| **Creazione evento da UI/API**, slug a runtime (oggi cotto nel build web), **reset evento** (`scripts/reset-event.sh`), cancellazione galleria, re-match di un utente da selfie conservato (`KEEP_SELFIES`, solo test, con consenso) | più round senza SQL e senza rebuild | 1,5 g |
| **"Non sono io"** con memoria al re-scan + score visibile in modalità debug | ground truth raccolta dai volontari stessi | 1 g |
| **`status.sh`** (età/profondità coda per tipo, foto per stato, p50/p95 face-service, `docker stats`, `df`, `iostat`) + CSV | capire "come si comporta" | 0,5 g |
| **Generatore sintetico** di foto di sala (ritratti incollati a 24–300 px, rotazioni, sfocatura) con etichette automatiche | curva recall(dimensione volto) prima di avere foto vere | 1 g |

Totale indicativo: 10–12 giorni/persona. Nulla di questo tocca il contratto esistente in modo incompatibile: sono rotte e colonne additive, script ed env.

---

## 6. Parametri consigliati per il server di test

```
# motore
FACE_ENGINE=insightface
INSIGHTFACE_MIN_COSINE=0.50
INSIGHTFACE_SURE_COSINE=0.70
INSIGHTFACE_ATTACH_MIN_COSINE=0.55     # da aggiungere
INSIGHTFACE_MIN_FACE_QUALITY=0.2
INSIGHTFACE_MAX_FACES=200
LIVENESS_CHECK=false                   # misurare i rigetti prima di attivarlo
# face-service
DET_SIZE=1024  DET_LONG_EDGE=2560      # da aggiungere; ONNX_THREADS = cpu/2; 16 vCPU: UVICORN_WORKERS=2
# worker
WORKER_REPLICAS=2  WORKER_CONCURRENCY=3 (8 vCPU) / 4 (16 vCPU)  MALLOC_ARENA_MAX=2  UV_THREADPOOL_SIZE=4
# postgres
POSTGRES_SHARED_BUFFERS=2GB (16 GB RAM) / 4GB (32 GB)  pg_stat_statements  log_min_duration_statement=500
# test box
SEED_DEMO=false  retention_days=3650  backup fermo o su disco separato  HTTPS con sottodominio reale (camera)
```
Server: 16 vCPU / 32 GB / disco dati dimensionato sulla **media reale** dei JPEG dei fotografi (misurarla con `du` su un campione) × numero foto × 1,1.

---

## 7. Piano di lavoro proposto

**Fase A — correttezza del riconoscimento (3–4 giorni).** Soglie e anchor (§2.1, 2.2), vettore del selfie per galleria (§2.3), rifiuto selfie di bassa qualità con motivo (§2.4), risoluzione di rilevamento 2560/1024 + filtri (§3), coerenza `face_vectors` (§2.6).

**Fase B — robustezza (1–2 giorni).** `FaceServiceUnavailable` come throttle + requeue foto in errore, priorità `index` 40, timeout fetch, `UVICORN_WORKERS`, heartbeat job, `finished_at/duration_ms`.

**Fase C — strumenti di test (5–6 giorni).** Importer, registro match / ricerca offline, `evaluate.py`, vista admin (galleria per email, debug foto), rate limit configurabili + link admin + Mailpit, creazione/reset evento, "Non sono io", `status.sh`, generatore sintetico.

**Fase D — campagna.** 1) Ingestione di un set reale con l'importer (anche 5–10k foto bastano per iniziare) e misura del throughput. 2) Null-selfie test ⇒ scelta di MIN/SURE. 3) 20 volontari × selfie (camera e file) + etichette su 300–500 foto ⇒ precision/recall, FN per dimensione volto. 4) Foto caricate *dopo* i selfie ⇒ verifica dell'attach. 5) Ripetere con DET 640 vs 1024 e con `LIVENESS_CHECK` on/off. 6) Riavvio del face-service con coda piena. Tutto con `status.sh` in registrazione.

Decisione aperta da prendere prima della fase A: conservare il vettore del selfie (§2.3, opzione a) — comporta una riga nella DPIA e nel testo di consenso ("il modello del tuo volto resta per la durata dell'evento per agganciare le foto caricate in seguito").
