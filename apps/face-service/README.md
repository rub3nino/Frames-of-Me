# face-service

Motore facce self-hosted di Frames of Me: [InsightFace](https://github.com/deepinsight/insightface) su CPU (detector SCRFD + embedding ArcFace 512-d, pacchetto `buffalo_l`, onnxruntime) dietro una piccola API FastAPI. Nessuna persistenza; i byte delle immagini non vengono mai loggati. Lo usa `packages/face-engine` quando `FACE_ENGINE=insightface`.

## Endpoint (porta 8090)

| Metodo | Path | Input | Risposta |
| --- | --- | --- | --- |
| `GET` | `/health` | | `200 { "ok": true, "model": "buffalo_l", "providers": ["CPUExecutionProvider"] }` (`503 { "ok": false }` se il modello non è caricato) |
| `GET` | `/metrics` | | `200` testo (`text/plain`): contatori e percentili, vedi sotto |
| `POST` | `/v1/embed` | multipart `image` (JPEG/PNG, ≤ 8 MiB, ≤ 120 MP); query `max_faces` 1–150 (default 150), `min_size` px (default 20) | `200 { "width", "height", "faces": [{ "bbox": { "left", "top", "width", "height" }, "score", "quality", "embedding": number[512], "norm", "yaw" }] }` |
| `POST` | `/v1/liveness` | multipart `image` | `200 { "live": boolean, "score": 0..1, "method": "silent-face" \| "none" }` |

Convenzioni di `/v1/embed`:

- `width`/`height` sono le dimensioni della foto originale (dopo l'orientamento EXIF); `bbox` è normalizzata 0..1 rispetto a quelle, quindi vale a qualsiasi scala.
- L'immagine viene ridotta a lato lungo `DET_LONG_EDGE` px (default 2560) prima della detection, che gira con input SCRFD `DET_SIZE` (default 1024); `min_size` e il calcolo di `quality` usano i pixel di quell'immagine ridotta. Fino alla v4 i default erano 1600/640: con 2560/1024 un volto da 60–80 px in una foto di sala da 24 MP viene ancora rilevato e riconosciuto, al prezzo di circa 1,6–2× il tempo per foto (misure in fondo; motivazione in `docs/test-readiness.md` §3).
- `score` = confidenza del detector (0..1). `quality` = `min(1, lato_lungo_bbox_px / 80) × score`: proxy economico della risoluzione del volto (formula invariata; con 2560 px lo stesso volto ha `quality` più alta perché è più grande nell'immagine di rilevamento).
- `embedding` è L2-normalizzato (norma 1): la similarità coseno è il prodotto scalare. `norm` è la norma L2 dell'embedding ArcFace *prima* della normalizzazione (tipicamente 15–35; valori bassi indicano volti sfocati, occlusi o molto piccoli; non entra in `quality`).
- `yaw` è una stima economica della rotazione della testa ricavata dai 5 landmark SCRFD: `(x_naso − x_centro_occhi) / distanza_occhi`, limitata a [−1, 1]. **Segno: positivo = naso verso il bordo destro dell'immagine**, negativo verso il bordo sinistro, ≈ 0 frontale; |yaw| ≳ 0,5 è già un tre quarti marcato. Specchiando la foto il segno si inverte. È `null` se il detector non ha fornito i landmark.
- Le facce sono ordinate per area del bbox decrescente; con `max_faces` si tengono le più grandi. Il tetto è 150 (`MAX_FACES_CAP` nel codice): ogni faccia costa un passaggio ArcFace (~10 ms).

Errori: `400` immagine non decodificabile (`{"detail":{"code":"undecodable_image"}}`), `413` troppo grande (`payload_too_large` oltre 8 MiB, `image_too_large` oltre 120 MP), `422` validazione (parametri fuori range, campo `image` mancante), `503` modello non caricato.

## Liveness

`/v1/liveness` usa un modello MiniFASNet (l'architettura di MiniVision Silent-Face-Anti-Spoofing) in ONNX, scaricato al build dell'immagine (`scripts/download_models.py`, SHA-256 verificato, ~1.9 MB) da [hairymax/Face-AntiSpoofing](https://github.com/hairymax/Face-AntiSpoofing) (pesi addestrati su CelebA-Spoof; quel repository non pubblica una licenza esplicita). Viene valutata la faccia più grande: crop quadrato 1,5× il bbox, 128×128, `score` = probabilità "live", `live = score ≥ LIVENESS_THRESHOLD` (default 0.5). Senza facce: `{ live: false, score: 0 }`.

È un deterrente passivo, non una garanzia: va usato insieme alla challenge attiva nel browser (vedi `apps/web`). Se i pesi non sono presenti (build con `--build-arg WITH_LIVENESS=0`, o `LIVENESS_MODEL` che punta a un file inesistente) il servizio risponde sempre `{ "live": true, "score": 0, "method": "none" }`.

## Metriche

`GET /metrics` risponde in testo semplice, una riga `nome valore`, senza dipendenza da client Prometheus (Caddy non la espone: è per `docker compose exec` o per uno scraper interno):

```
face_service_model buffalo_l
face_service_uvicorn_workers 1
face_service_model_concurrency 2
face_service_det_size 1024
face_service_det_long_edge 2560
face_service_embed_requests_total 1240
face_service_embed_errors_total 3
face_service_embed_faces_detected_total 5120
face_service_embed_faces_returned_total 5088
face_service_embed_latency_window 500
face_service_embed_latency_ms_p50 158.0
face_service_embed_latency_ms_p95 310.5
face_service_embed_latency_ms_max 612.0
face_service_liveness_requests_total 42
...
```

I percentili sono calcolati sulle ultime 500 chiamate `/v1/embed` (decodifica + inferenza, upload escluso). I contatori sono per processo: con `UVICORN_WORKERS > 1` ogni worker ha i propri e la risposta riflette il worker che ha servito la richiesta.

## Variabili d'ambiente

| Var | Default | Significato |
| --- | --- | --- |
| `MODEL_ROOT` | `/models` | radice dei modelli (layout insightface: `<root>/models/<MODEL_NAME>/`) |
| `MODEL_NAME` | `buffalo_l` | pacchetto insightface |
| `ONNX_THREADS` | numero di CPU | thread intra-op di onnxruntime per inferenza |
| `DET_SIZE` | `1024` | lato dell'input del detector SCRFD (640 = comportamento v4) |
| `DET_LONG_EDGE` | `2560` | lato lungo a cui viene ridotta la foto prima della detection (1600 = comportamento v4) |
| `UVICORN_WORKERS` | `1` | processi uvicorn (letto dal `CMD` del Dockerfile); ogni processo carica una copia del modello, ≈ 1–1,5 GB RSS l'uno |
| `MODEL_CONCURRENCY` | `2` | inferenze contemporanee per processo (semaforo sul modello) |
| `DECODE_CONCURRENCY` | `4` | decodifiche Pillow contemporanee per processo (semaforo; una foto da 20 MP occupa ~60 MB durante la decodifica) |
| `LIVENESS_MODEL` | `<MODEL_ROOT>/antispoof/AntiSpoofing_bin_1.5_128.onnx` | pesi anti-spoofing; se assenti → `method: "none"` |
| `LIVENESS_THRESHOLD` | `0.5` | soglia su `score` per `live = true` |

In `deploy/compose.yml` sono mappate a `FACE_SERVICE_WORKERS`, `FACE_DET_SIZE`, `FACE_DET_LONG_EDGE`, `FACE_MODEL_CONCURRENCY`, `FACE_DECODE_CONCURRENCY` (più `FACE_SERVICE_THREADS`, `FACE_SERVICE_CPUS`, `FACE_SERVICE_MEMORY`). Dimensionare `FACE_SERVICE_MEMORY` ≈ worker × 1,5 GB + 1 GB.

## Avvio locale (venv)

```sh
cd apps/face-service
python3 -m venv .venv && . .venv/bin/activate        # Python 3.11+
pip install -r requirements.txt && pip install --no-deps -r requirements-insightface.txt
pip install -r requirements-dev.txt                   # per i test
python scripts/download_models.py --root ~/.rephoto-models   # ~280 MB una tantum
MODEL_ROOT=~/.rephoto-models uvicorn app.main:app --port 8090
curl -F image=@foto.jpg "http://localhost:8090/v1/embed?max_faces=10"
```

`insightface` va installato con `--no-deps` perché dichiara `opencv-python` (richiede libGL); qui si usa `opencv-python-headless` e le sue altre dipendenze sono già in `requirements.txt`.

Test: `MODEL_ROOT=~/.rephoto-models pytest`. I test con analizzatore stub (bbox, quality, yaw, limiti, semafori, `/metrics`, codici di errore) girano sempre; quelli sul modello reale (`tests/test_api_real.py`: segno di `yaw` su foto specchiata, volti piccoli a 1600/640 contro 2560/1024, latenze) vengono saltati con motivo se il pacchetto non è caricabile. `test_embed_latency` stampa le misure per entrambe le configurazioni e include le foto da 20 MP in `photo/` alla radice del repo, se presenti.

## Docker

```sh
docker build -t rephoto-face-service apps/face-service      # scarica i modelli al build
docker run --rm -p 8090:8090 rephoto-face-service
```

Immagine `python:3.11-slim`, utente non root, modelli in `/models`, nessun accesso di rete a runtime. Da repo root `docker compose up -d` la avvia insieme a Postgres (`pgvector/pgvector:pg16`), MinIO e Mailpit.

## Aspettative su CPU

`UVICORN_WORKERS` processi; in ciascuno l'inferenza gira in thread con `asyncio.Semaphore(MODEL_CONCURRENCY)` sul modello (default 2 inferenze contemporanee, le altre richieste aspettano in coda) e `asyncio.Semaphore(DECODE_CONCURRENCY)` sulla decodifica.

Misure `/v1/embed` su foto reali da 20 MP (3712×5568, 1–2 volti; Apple M-series, `ONNX_THREADS=4`, un worker, richieste sequenziali, decodifica inclusa):

| Configurazione | mediana | p95 |
| --- | --- | --- |
| v4: `DET_LONG_EDGE=1600`, `DET_SIZE=640` | 88–101 ms | ~105 ms |
| v5: `DET_LONG_EDGE=2560`, `DET_SIZE=1024` | 145–176 ms | ~178 ms |

Il passaggio a 2560/1024 costa circa 1,6–1,8× ma rileva volti che a 1600/640 vanno persi (nella foto di prova con due persone a 2560 compare il secondo volto). Su 4 vCPU x86 aspettarsi ~250–450 ms per foto, cioè 2–4 foto/s per worker; il costo cresce con il numero di facce (un passaggio ArcFace per faccia, ~10 ms l'una). `/v1/liveness` ~160 ms.

Memoria: ~1–1,5 GB residenti per worker (modello + buffer di decodifica), quindi `FACE_SERVICE_MEMORY` ≈ worker × 1,5 GB + 1 GB. Con più CPU conviene `ONNX_THREADS` ≈ CPU / (worker × `MODEL_CONCURRENCY`) per non sovrapporre gli slot di inferenza; per tornare al comportamento v4 impostare `FACE_DET_LONG_EDGE=1600` e `FACE_DET_SIZE=640`.
