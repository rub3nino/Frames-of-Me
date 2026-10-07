# scripts/bench — misure di capacità

## `index-throughput.ts` — foto/ora della pipeline di riconoscimento

Risponde all'unica domanda da cui si dimensiona tutto il deployment e che non era mai stata
misurata: **quante foto all'ora** un host porta da `derive` a `index` a `attach` con la detection
sul lato lungo di 2560 px.

Guida la pipeline **vera**: lo stesso percorso di upload di `scripts/ingest` (oggetto in MinIO,
riga in `photos`, job `derive`), poi il vero worker loop (`apps/worker/src/loop.ts`) con i veri
handler, il vero face engine e il vero face service. Niente è simulato, quindi i numeri sono quelli
che produrrebbero api e worker.

```sh
# in locale (face-service e MinIO avviati, FACE_ENGINE=insightface in .env)
node --env-file=.env --import tsx scripts/bench/index-throughput.ts \
  --dir /data/foto-campione --photos 200 --concurrency 4 \
  --json bench.json --cleanup
```

### Opzioni principali

| Opzione | Default | Effetto |
| --- | --- | --- |
| `--dir <cartella>` | — | foto **vere** dell'evento, ricorsiva (`.jpg .jpeg .png`); riusate ciclicamente se `--photos` è maggiore del numero di file |
| `--source <file>` | — | una sola immagine per tutte le foto |
| `--photos <n>` | 100 | foto spinte nella pipeline nella misura |
| `--concurrency <n>` | `WORKER_CONCURRENCY` | job in volo, cioè la configurazione del worker |
| `--warmup <n>` | 3 | foto elaborate e **scartate** dalle statistiche (il primo caricamento del modello falsa la p50) |
| `--event <slug>` | `bench-throughput` | evento creato e usato; nessun evento esistente viene toccato |
| `--face-container <nome>` | autodetect `*face-service*` | container da cui leggere CPU/RAM con `docker stats` |
| `--json <file>` | — | risultato completo, **ogni singolo job**, in JSON |
| `--cleanup` | off | cancella evento, foto e oggetti alla fine |
| `--keep-queue` | off | accetta di partire con job già in coda (altrimenti si rifiuta: misurerebbe anche quelli) |

Ogni copia di una foto riceve byte casuali **dopo** l'EOI del JPEG: i pixel (e quindi i volti) sono
identici, il `sha256` cambia, quindi il vincolo `unique (event_id, sha256)` non rifiuta le copie.
È lo stesso trucco di `scripts/ingest --synth`.

### Serve usare foto vere

Senza `--dir`/`--source` lo script ricade su `scripts/loadtest/fixtures/sample.jpg` e **marca il
run come UNREPRESENTATIVE**: è 640×480 e non contiene volti, quindi la detection fa una frazione
del lavoro di una foto di sala da 24 MP e l'embedding per volto (ArcFace, ~10 ms a volto) non viene
eseguito affatto. Il numero che esce è un **limite superiore**, non una misura.

Il repository non contiene immagini con volti (e non deve: sono dati biometrici). Per una misura
rappresentativa servono foto vere dell'evento, oppure immagini sintetiche costruite con
`scripts/eval/synth.py` partendo da ritratti propri.

### Come si esegue sull'host di produzione

Le immagini Docker non contengono `scripts/`: si monta il repo e la cartella delle foto in un
container `worker` una tantum, come per `scripts/ingest` (ha `sharp` e tutte le dipendenze, e vede
`postgres`, `minio` e `face-service` sulla rete di compose).

```sh
cd /srv/rephoto/deploy

# 1. la coda deve essere vuota: il benchmark si rifiuta di partire con job pendenti
docker compose --env-file .env.production exec -T postgres \
  psql -U rephoto -d rephoto -tAc "select count(*) from jobs where status in ('queued','running')"

# 2. il benchmark, con 200 foto vere dell'evento montate in sola lettura.
#    --cleanup rimuove evento, foto e oggetti alla fine; /state raccoglie il JSON.
docker compose --env-file .env.production run --rm --no-deps \
  -v /srv/rephoto/scripts:/app/scripts:ro \
  -v /data/foto-campione:/photos:ro \
  -v /srv/rephoto/bench:/state \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --entrypoint node worker --import tsx /app/scripts/bench/index-throughput.ts \
  --dir /photos --photos 200 --concurrency 4 \
  --json /state/bench.json --cleanup
```

Note sull'esecuzione in produzione:

- `/app/scripts` **deve** stare sotto `/app`, perché `@rephoto/*` si risolve da `/app/node_modules`
  (stessa ragione di `scripts/ingest`).
- Il socket Docker montato serve solo a `docker stats` per CPU e RAM del face service. Senza, il
  benchmark funziona e stampa `face service CPU/RAM not measured`: montare il socket dà al
  container il controllo del demone Docker, quindi su un host condiviso conviene **ometterlo** e
  leggere `docker stats` a mano in un'altra shell durante il run.
- `--concurrency` va fatto variare: il numero da riportare è quello alla concorrenza con cui girerà
  il worker in produzione (`WORKER_CONCURRENCY` × `WORKER_REPLICAS`). Con un solo processo di
  benchmark si misura un worker; per due repliche si lancia il benchmark due volte in parallelo
  oppure si raddoppia `--concurrency`.
- Il face service è il collo di bottiglia atteso: se `index` mostra `requeued=` nelle outcome, è
  saturo e il numero di foto/ora è quello del *suo* limite, non del worker. Alzare
  `FACE_SERVICE_WORKERS`/`FACE_MODEL_CONCURRENCY` e rimisurare.
- Da eseguire **prima** dell'evento e su dati veri; il risultato va in `docs/face-throughput.md`.

### Cosa riporta

- `THROUGHPUT` in foto/ora, dal tempo a parete dello svuotamento della coda — è il numero con cui
  si dimensiona l'host;
- per ogni tipo di job: conteggio, p50, p95, p99, max, media **sui soli job riusciti**, più la
  ripartizione degli esiti (`done`/`retry`/`requeued`/`error`), così un run con errori non può
  essere confuso con uno pulito;
- volti per foto (la detection scala con quello);
- CPU e RSS del container del face service (p50 e max su campioni al secondo) e CPU/RSS del
  processo di benchmark;
- con `--json`, ogni singolo job con il suo tempo, per rifare le statistiche a posteriori.

L'ultima misura eseguita è in [`docs/face-throughput.md`](../../docs/face-throughput.md).
