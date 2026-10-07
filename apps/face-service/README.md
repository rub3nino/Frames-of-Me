# face-service

Motore facce self-hosted di RePhoto: [InsightFace](https://github.com/deepinsight/insightface) su CPU (detector SCRFD + embedding ArcFace 512-d, pacchetto `buffalo_l`, onnxruntime) dietro una piccola API FastAPI. Nessuna persistenza; i byte delle immagini non vengono mai loggati. Lo usa `packages/face-engine` quando `FACE_ENGINE=insightface`.

## Endpoint (porta 8090)

| Metodo | Path | Input | Risposta |
| --- | --- | --- | --- |
| `GET` | `/health` | | `200 { "ok": true, "model": "buffalo_l", "providers": ["CPUExecutionProvider"] }` (`503 { "ok": false }` se il modello non è caricato) |
| `POST` | `/v1/embed` | multipart `image` (JPEG/PNG, ≤ 8 MiB, ≤ 120 MP); query `max_faces` 1–50 (default 50), `min_size` px (default 20) | `200 { "width", "height", "faces": [{ "bbox": { "left", "top", "width", "height" }, "score", "quality", "embedding": number[512] }] }` |
| `POST` | `/v1/liveness` | multipart `image` | `200 { "live": boolean, "score": 0..1, "method": "silent-face" \| "none" }` |

Convenzioni di `/v1/embed`:

- `width`/`height` sono le dimensioni della foto originale (dopo l'orientamento EXIF); `bbox` è normalizzata 0..1 rispetto a quelle, quindi vale a qualsiasi scala.
- L'immagine viene ridotta a lato lungo 1600 px prima della detection; `min_size` e il calcolo di `quality` usano i pixel di quell'immagine ridotta.
- `score` = confidenza del detector (0..1). `quality` = `min(1, lato_lungo_bbox_px / 80) × score`: proxy economico della risoluzione del volto.
- `embedding` è L2-normalizzato (norma 1): la similarità coseno è il prodotto scalare.
- Le facce sono ordinate per area del bbox decrescente; con `max_faces` si tengono le più grandi.

Errori: `400` immagine non decodificabile (`{"detail":{"code":"undecodable_image"}}`), `413` troppo grande (`payload_too_large` oltre 8 MiB, `image_too_large` oltre 120 MP), `422` validazione (parametri fuori range, campo `image` mancante), `503` modello non caricato.

## Liveness

`/v1/liveness` usa un modello MiniFASNet (l'architettura di MiniVision Silent-Face-Anti-Spoofing) in ONNX, scaricato al build dell'immagine (`scripts/download_models.py`, SHA-256 verificato, ~1.9 MB) da [hairymax/Face-AntiSpoofing](https://github.com/hairymax/Face-AntiSpoofing) (pesi addestrati su CelebA-Spoof; quel repository non pubblica una licenza esplicita). Viene valutata la faccia più grande: crop quadrato 1,5× il bbox, 128×128, `score` = probabilità "live", `live = score ≥ LIVENESS_THRESHOLD` (default 0.5). Senza facce: `{ live: false, score: 0 }`.

È un deterrente passivo, non una garanzia: va usato insieme alla challenge attiva nel browser (vedi `apps/web`). Se i pesi non sono presenti (build con `--build-arg WITH_LIVENESS=0`, o `LIVENESS_MODEL` che punta a un file inesistente) il servizio risponde sempre `{ "live": true, "score": 0, "method": "none" }`.

## Variabili d'ambiente

| Var | Default | Significato |
| --- | --- | --- |
| `MODEL_ROOT` | `/models` | radice dei modelli (layout insightface: `<root>/models/<MODEL_NAME>/`) |
| `MODEL_NAME` | `buffalo_l` | pacchetto insightface |
| `ONNX_THREADS` | numero di CPU | thread intra-op di onnxruntime per inferenza |
| `DET_SIZE` | `640` | lato dell'input del detector SCRFD |
| `LIVENESS_MODEL` | `<MODEL_ROOT>/antispoof/AntiSpoofing_bin_1.5_128.onnx` | pesi anti-spoofing; se assenti → `method: "none"` |
| `LIVENESS_THRESHOLD` | `0.5` | soglia su `score` per `live = true` |

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

Test: `MODEL_ROOT=~/.rephoto-models pytest`. I test con analizzatore stub (bbox, quality, limiti, codici di errore) girano sempre; quelli sul modello reale (`tests/test_api_real.py`) vengono saltati con motivo se il pacchetto non è caricabile.

## Docker

```sh
docker build -t rephoto-face-service apps/face-service      # scarica i modelli al build
docker run --rm -p 8090:8090 rephoto-face-service
```

Immagine `python:3.11-slim`, utente non root, modelli in `/models`, nessun accesso di rete a runtime. Da repo root `docker compose up -d` la avvia insieme a Postgres (`pgvector/pgvector:pg16`), MinIO e Mailpit.

## Aspettative su CPU

Un worker uvicorn, inferenza in thread con `asyncio.Semaphore(2)` sul modello: al massimo due inferenze contemporanee, le altre richieste aspettano in coda. Misure (Apple M-series, 4 thread): `/v1/embed` ~150–180 ms per una foto da 1600 px con 6 facce, ~35 ms senza facce; `/v1/liveness` ~160 ms. Su 4 vCPU x86 aspettarsi ~150–300 ms per foto, cioè 7–12 foto/s per istanza. Il costo cresce con il numero di facce (un passaggio ArcFace per faccia, ~10 ms l'una). Memoria: ~1 GB residente. Con più CPU conviene lasciare `ONNX_THREADS` ≈ CPU/2 per non sovrapporre i due slot del semaforo.
