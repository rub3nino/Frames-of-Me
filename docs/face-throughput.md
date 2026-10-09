# Frames of Me — throughput della pipeline di riconoscimento (v6 F1)

Data della misura: **2026-10-07**. Strumento: [`scripts/bench/index-throughput.ts`](../scripts/bench/index-throughput.ts)
(vedi [`scripts/bench/README.md`](../scripts/bench/README.md)). Codice: branch `v6/ops` sopra `8ac072a`.

Questo è il numero da cui si dimensiona il deployment e che prima della v6 **non era mai stato
misurato**: le stime in `deploy/README.md` § 1 e in `docs/test-readiness.md` § 4 erano
congetture.

---

## 0. Avvertenza: questa misura NON è il numero di produzione

Due limiti, entrambi noti e nessuno dei due aggirabile in sviluppo:

1. **Zero volti.** Il repository non contiene immagini con volti (sono dati biometrici e non
   devono starci). La misura è stata fatta su un JPEG 6000×4000 **senza volti**, quindi SCRFD
   esegue la detection per intero ma lo stadio di **embedding ArcFace per volto non viene eseguito
   mai**. Con ~3 volti per foto in una foto di sala va aggiunto il costo di 3 passaggi ArcFace per
   foto, che **non è stato misurato** (il commento in `apps/face-service/app/main.py:39` lo stima
   ~10 ms a volto, ed è una stima, non una misura).
2. **Hardware sbagliato.** MacBook arm64 con Docker Desktop, non il VPS x86 di produzione. Il
   face service girava con `--cpus 4 --memory 4g` (gli stessi limiti di `compose.yml`), ma un core
   arm64 di un Mac e un vCPU Hetzner non sono la stessa cosa.

**Quindi: i numeri qui sotto sono un LIMITE SUPERIORE.** Prima dell'evento la misura va rifatta
sull'host di produzione e con foto vere, con la procedura in `scripts/bench/README.md` § "Come si
esegue sull'host di produzione". Quello che resta valido indipendentemente dall'hardware è la
**forma** delle curve: dove satura, quale parametro costa e quale no (§ 3 e § 4).

---

## 1. Configurazione misurata

| | |
| --- | --- |
| Face service | `rephoto-face-service` ricostruito dal repo, `buffalo_l`, `CPUExecutionProvider` |
| Limiti del container | `--cpus 4 --memory 4g` (= `FACE_SERVICE_CPUS`/`MEMORY` di default) |
| `ONNX_THREADS` | 4 |
| `DET_SIZE` (input SCRFD) | 1024 (default di produzione) |
| `DET_LONG_EDGE` / `FACE_DETECT_LONG_EDGE` | 2560 |
| `MODEL_CONCURRENCY` / `DECODE_CONCURRENCY` | 2 / 4 |
| `FACE_INDEX_SOURCE` | `original` |
| Foto | JPEG 6000×4000 (24 MP), 0,6 MiB, **0 volti** |
| Per run | 3 foto di warmup scartate + 60 foto misurate |
| Postgres / MinIO | container separati sulla stessa macchina |

La pipeline misurata è quella vera: percorso di upload di `scripts/ingest`, poi
`apps/worker/src/loop.ts` con gli handler veri, il face engine vero e il face service vero.
`derive → index → attach` per ogni foto. Niente è simulato.

---

## 2. Il numero

Alla configurazione di produzione (`DET_SIZE=1024`, lato lungo 2560, `WORKER_CONCURRENCY=4`):

> **12.700 foto/ora** — `index` p50 858 ms, p95 929 ms — face service saturo a ~400 % di CPU
> (il suo limite di 4 core) e ~1,0 GiB di RSS.
>
> **Limite superiore**: senza volti e su hardware diverso (§ 0).

Due run indipendenti della stessa configurazione: 12.722 e 12.734 foto/ora (0,1 % di differenza),
quindi la misura è ripetibile.

Per le 150.000 foto della campagna di test: 150.000 / 12.700 ≈ **12 ore** di un solo face service
a 4 core, *senza* contare l'embedding dei volti. Con margine per i volti e per hardware più lento,
pianificare **1–2 giorni** di sola indicizzazione, oppure più repliche del face service.

---

## 3. Dove satura: la concorrenza

`DET_SIZE=1024`, lato lungo 2560. `--concurrency` è `WORKER_CONCURRENCY` di un worker.

| `--concurrency` | foto/ora | `index` p50 | `index` p95 | `index` max | CPU face p50 | RAM face p50 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 9.023 | 290 ms | 301 ms | 330 ms | 245 % | 975 MiB |
| 2 | 10.752 | 492 ms | 551 ms | 562 ms | 310 % | 1012 MiB |
| **4** | **12.734** | 858 ms | 929 ms | 996 ms | 399 % | 1029 MiB |
| 8 | 12.554 | 1732 ms | 1904 ms | 1976 ms | 400 % | 1177 MiB |

`derive` p50 52–59 ms e `attach` p50 1 ms a ogni concorrenza: **non sono il collo di bottiglia**,
il face service lo è.

Lettura: il ginocchio è a **4**. Da 4 a 8 il throughput non sale (−1,4 %, dentro il rumore) ma la
latenza di `index` raddoppia esattamente: è coda, non lavoro. La CPU del face service è già
inchiodata al suo limite di 4 core da `--concurrency 4` in poi.

**Conseguenze operative**

- `WORKER_CONCURRENCY=4` (il default di `compose.yml`) è la scelta giusta per **un** face service
  a 4 core. Alzarlo non aggiunge foto/ora, aggiunge solo attesa in coda e profondità di coda
  visibile in `admin/metrics`.
- Con `WORKER_REPLICAS=2` × `WORKER_CONCURRENCY=4` = 8 job in volo si è nel regime della riga 8:
  stesso throughput, latenza doppia. Per sfruttare due worker serve **più capacità di face
  service** (`FACE_SERVICE_WORKERS`, `FACE_SERVICE_CPUS`), non più worker.
- Se `index` mostra `requeued=` negli esiti, il face service sta rifiutando: il numero di foto/ora
  è il suo, non quello del worker.

---

## 4. Quale parametro costa davvero: `DET_SIZE`, non il lato lungo

Questa è la scoperta che corregge un'assunzione scritta nel codice.

### 4a. Lato lungo (`FACE_DETECT_LONG_EDGE`), a `DET_SIZE=1024`, `--concurrency 4`

| lato lungo | foto/ora | `index` p50 |
| --- | --- | --- |
| 1280 | 13.442 | 813 ms |
| 1600 | 13.495 | 821 ms |
| 2560 | 12.734 | 858 ms |

Passare da 1600 a 2560 px costa **~6 %** di throughput e ~4 % di latenza di `index`. Quasi niente.

### 4b. `DET_SIZE` (input SCRFD), a lato lungo 2560, `--concurrency 4`

| `DET_SIZE` | foto/ora | `index` p50 | RAM face p50 |
| --- | --- | --- | --- |
| 640 | **23.981** | 311 ms | 861 MiB |
| 1024 | **12.734** | 858 ms | 1029 MiB |

Passare da 640 a 1024 costa **1,9× il throughput** (2,8× la latenza di `index`).

### Perché, e cosa correggere

`deploy/compose.yml` annota accanto a `DET_SIZE`/`DET_LONG_EDGE`:

> *Detection on a 2560 px long edge with a 1024 px SCRFD input: ~2x the cost of the old 1600/640.*

Il fattore ~2× è **giusto**, ma la causa attribuita è sbagliata: quel 2× è **tutto** di `DET_SIZE`
640→1024, e **non** del lato lungo 1600→2560, che costa il 6 %. La ragione è strutturale: SCRFD
gira su un input quadrato di `DET_SIZE` px **qualunque** sia la risoluzione sorgente, quindi
cambiare il lato lungo cambia solo il costo di decode e resize, non quello della rete.

Conseguenza pratica: **il lato lungo a 2560 è quasi gratis e va tenuto** — è ciò che conserva i
volti da 60–80 px delle ultime file (`docs/test-readiness.md` § 3) — mentre `DET_SIZE` è l'unico
vero interruttore costo/recall. Se serve throughput, la leva è `DET_SIZE`, e va mossa solo con una
misura di recall accanto (`scripts/eval/`), perché è esattamente la leva che fa perdere i volti
piccoli.

---

## 5. Come riprodurre

```sh
# face service, MinIO e Postgres avviati; FACE_ENGINE=insightface
node --env-file=.env --import tsx scripts/bench/index-throughput.ts \
  --dir /data/foto-vere --photos 200 --warmup 3 --concurrency 4 \
  --json bench.json --cleanup
```

Sull'host di produzione: `scripts/bench/README.md` § "Come si esegue sull'host di produzione".

Il JSON contiene **ogni singolo job** con il suo tempo, quindi le statistiche si possono rifare a
posteriori senza rieseguire la misura.

---

## 6. Da rifare prima dell'evento

- [ ] Rieseguire con **foto vere dell'evento** (volti reali) sull'**host di produzione**: è questa
      la misura che vale, e sostituisce ogni numero di questo documento.
- [ ] Misurare il costo marginale **per volto** (confronto a pari risoluzione tra foto con 0, ~3 e
      ~20 volti): oggi è una stima nel commento del codice, non un dato.
- [ ] Rimisurare con `FACE_SERVICE_WORKERS=2` (+ `FACE_SERVICE_CPUS`/`MEMORY`), per sapere se due
      repliche di worker trovano capacità sufficiente.
- [ ] Correggere il commento di `deploy/compose.yml` sulla causa del 2× (§ 4), oppure sostituirlo
      con un rimando a questo documento.

## 7. Nota a margine trovata durante la misura

L'immagine `rephoto-face-service:latest` presente sulla macchina di sviluppo era più vecchia del
codice: imponeva `max_faces ≤ 50`, mentre `apps/face-service/app/main.py:40` ha
`MAX_FACES_CAP = 150` e il worker chiede 100 volti
(`packages/face-engine/src/insightface.ts:25`). Risultato: **tutti** i job `index` fallivano con
`422 ... max_faces ... less than or equal to 50`, dopo 5 tentativi, con la foto in stato `error`.

Non è un difetto del codice (dopo la ricostruzione dell'immagine dal repo tutto funziona), ma è un
modo silenzioso di rompere l'intera indicizzazione: il face service risponde, `/health` dice `ok`,
e ogni singola foto fallisce. In produzione `docker compose build` ricostruisce l'immagine, quindi
il rischio è nei soli ambienti dove l'immagine viene riusata senza rebuild. Vale la pena, in un
giro successivo, esporre la versione/il commit del face service in `/health` e confrontarla all'avvio
del worker.
