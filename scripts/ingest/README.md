# scripts/ingest — importer server-side

Carica una cartella di foto **direttamente** in MinIO e in Postgres, senza passare dall'API: è lo
strumento per i 150k file della campagna di test (il browser non lo è). Ogni foto finisce
esattamente come la lascia `POST /v1/uploads/complete`: riga in `photos` (`status = uploaded`,
`original_status = present`, chiave `originals/<eventId>/<photoId>`), un job `derive` con
dedupe `derive:<photoId>`; da lì il worker fa `derive → index → attach` come per un upload normale.

```sh
npm run ingest -- --dir /data/foto --event conferenza-2026 \
  --photographer foto1@test.rephoto.local --parallel 8 \
  --manifest manifest.csv --state ingest.state.jsonl
# equivale a: node --env-file=.env --import tsx scripts/ingest/ingest.ts …
```

| Opzione | Default | Effetto |
| --- | --- | --- |
| `--dir <cartella>` | — | ricorsiva; `.jpg .jpeg .png` (+ `.heic .heif .tif .tiff` con `--convert`) |
| `--event <slug>` | — | l'evento deve esistere (`npm run seed:test`) |
| `--photographer <email>` | — | creato e aggiunto a `event_photographers` se manca |
| `--parallel <n>` | 8 | file in volo (sha256 + PUT + insert) |
| `--rate <foto/s>` | illimitato | limita gli avvii al secondo (es. `--rate 3.3` ≈ 12.000/h per simulare l'evento) |
| `--synth <n>` | 0 | per ogni foto vera importa anche n copie con byte casuali dopo l'EOI: stessi volti, sha256 diverso (moltiplica il corpus con volti **veri**; tag `synth`) |
| `--state <jsonl>` | — | ripresa: una riga per file processato; al riavvio i file già presenti vengono saltati (gli `error` vengono ritentati) |
| `--manifest <csv>` | — | `filename,sha256,photoId,status,bytes,ms` in append (serve a `scripts/eval`) |
| `--tags a,b` | — | `photos.tags` (colonna della migrazione 007; se manca, avviso e ignorato) |
| `--convert` | off | HEIC/PNG/TIFF → JPEG q92 con sharp (sha256 dei byte convertiti); HEIC solo se libvips sa decodificarlo |
| `--web-first` | off | rende qui il derivato web 1600 px e lo registra (come fa il browser): il worker fa solo il thumb prima di indicizzare — utile per alleggerire il worker |
| `--limit <n>` | — | si ferma dopo n file |
| `--dry-run` | off | scansiona, calcola gli sha256 e stampa il piano: niente DB né MinIO |

Stati nel manifest: `uploaded`, `duplicate` (stesso sha256 già nell'evento: non viene ricaricata,
`photoId` è quello esistente), `error` (motivo su stderr e nello state), `dry-run`.

Ambiente: `DATABASE_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
`S3_REGION`, `S3_FORCE_PATH_STYLE` — gli stessi nomi di api/worker (`.env` in locale).

Progresso: una riga ogni 100 file (`uploaded/dup/err`, foto/s, MiB/s). Gli errori per file non
fermano il run; il codice di uscita è 1 se ce n'è stato almeno uno.

## Sul VPS

Le immagini Docker non contengono `scripts/`; si monta il repo e la cartella delle foto in un
container `worker` una tantum (ha `sharp` e tutte le dipendenze, e vede `postgres`/`minio` sulla
rete di compose):

```sh
cd /srv/rephoto/deploy
docker compose --env-file .env.production run --rm --no-deps \
  -v /srv/rephoto/scripts:/app/scripts:ro -v /data/foto:/photos:ro -v /srv/rephoto/ingest:/state \
  --entrypoint node worker --import tsx /app/scripts/ingest/ingest.ts \
  --dir /photos --event "$EVENT_SLUG" --photographer foto1@test.rephoto.local \
  --parallel 8 --manifest /state/manifest.csv --state /state/ingest.state.jsonl
```

(`/app/scripts` deve stare sotto `/app` perché `@rephoto/*` si risolve da `/app/node_modules`.)
Con `--rate` si simula il ritmo dei fotografi; senza, l'importer satura il disco e il worker
accumula coda `derive`/`index`: è voluto, `status.sh` mostra come la smaltisce.

Throughput tipico in locale: sha256 + PUT di JPEG da 8 MB ≈ 40–80 foto/s con `--parallel 8` su
SSD; il collo di bottiglia è poi il face-service (vedi `docs/test-readiness.md` § 4).
