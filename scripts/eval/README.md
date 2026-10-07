# scripts/eval — misurare "solo le mie foto"

Tre script Python e un protocollo. Rispondono alla domanda della campagna di test: ogni persona
riceve **esattamente e solo** le foto in cui compare? E se no, a che soglia, su quali volti?

| File | Cosa fa | Serve |
| --- | --- | --- |
| `synth.py` | genera "foto di sala" sintetiche da ritratti: volti a 24–300 px (scala 1600), rotazione, sfocatura, qualità JPEG, con `labels.csv` automatico | numpy, Pillow |
| `offline-search.py` | embedda selfie con il face-service e li confronta con **tutti** i vettori dell'evento (stessa query pgvector del motore) → CSV di coseni grezzi | psycopg, face-service raggiungibile |
| `evaluate.py` | etichette + manifest + export gallerie (± match-hits/offline-search, faces) → precision/recall per soggetto e globale, split sicuro/forse, istogrammi, sweep di soglia, FN per dimensione del volto → `report.md` | solo stdlib (matplotlib opzionale per i PNG) |
| `null-selfie.md` | il protocollo del null-selfie test (selfie di assenti ⇒ coda impostore reale) | — |

```sh
python3 -m venv .venv-eval && . .venv-eval/bin/activate
pip install -r scripts/eval/requirements-eval.txt
```

## 1. Preparare il corpus

**Foto vere** (preferibile): caricarle con `scripts/ingest/ingest.ts --manifest manifest.csv`. Il
manifest (`filename,sha256,photoId,status,bytes,ms`) collega i nomi dei file agli id delle foto.

**Foto sintetiche** (per la curva recall ↔ dimensione del volto, prima di avere foto di sala):

```sh
python scripts/eval/synth.py --portraits ritratti/ --backgrounds sfondi/ --out synth/ \
  --count 300 --sizes 24,32,48,64,80,100,140,200,300 --canvas 6000x4000 --max-faces 4
node --env-file=.env --import tsx scripts/ingest/ingest.ts --dir synth/ --event <slug> \
  --photographer synth@test.rephoto.local --tags synth --manifest manifest-synth.csv
```

`ritratti/` deve contenere **un file per persona, ritagliato a testa e spalle**: senza un
riquadro del volto lo script tratta l'intera immagine come volto, e una foto intera a figura
intera darebbe volti molto più piccoli del dichiarato. In alternativa passare
`--portraits-csv ritratti.csv` con `file,subject,x,y,w,h` (riquadro normalizzato 0–1; si ottiene
anche dal face-service: `curl -F image=@file.jpg localhost:8090/v1/embed`). Il soggetto è il nome
del file senza estensione. Output: le immagini, `labels.csv` (`subject,filename`) e
`synth_meta.csv` (dimensione esatta del volto per coppia, usato da `evaluate.py --synth-meta`).

## 2. Etichette

`labels.csv` — una riga per ogni coppia (persona, foto) vera:

```csv
subject,filename
alice,IMG_0001.jpg
alice,IMG_0002.jpg
bob,IMG_0002.jpg
```

Regola: una foto che compare in `labels.csv` è **etichettata completamente** (tutte le persone
presenti sono elencate); le foto assenti dal file sono "non etichettate" e le predizioni su di esse
non vengono giudicate (contate come *unverified*). Con 300–500 foto etichettate da 20 volontari si
ottiene una misura solida. I volontari possono etichettare dal loro telefono: «Non sono io» nella
galleria finisce in `feedback.csv` (export admin) e `evaluate.py` esclude dalle predizioni le foto
marcate `not_me`.

`subjects.csv` — chi è chi: `subject,email` (l'e-mail con cui il volontario ha fatto il selfie).
`scripts/seed-test.ts` ne scrive uno per i partecipanti generati.

## 3. Raccogliere le predizioni

Dopo i selfie (dal telefono con `/`, o da file: `POST /v1/events/<slug>/selfie` con il cookie di
`cookies-participants.txt`):

- `galleries.csv` — admin → Esporta → gallerie (`GET /v1/admin/export/galleries.csv?eventId=`):
  `email,photo_id,score,source,...`.
- `match-hits.csv` — con `MATCH_LOG=true` il worker registra **tutti** gli hit del match, anche sotto
  soglia (`GET /v1/admin/export/match-hits.csv?eventId=`): serve allo sweep di soglia.
- oppure `offline-search.csv` da `offline-search.py` (stesso ruolo, senza passare dall'app):
  ```sh
  DATABASE_URL=postgres://… python scripts/eval/offline-search.py --event <slug> \
    --selfies selfies/ --face-service http://localhost:8090 --out offline-search.csv
  ```
  I selfie si chiamano `<subject>_<n>.jpg` (o `--subjects-csv filename,subject`).
- `faces.csv` (opzionale, per i falsi negativi per dimensione del volto):
  ```
  psql "$DATABASE_URL" -c "\copy (select f.photo_id, f.bbox::text as bbox from faces f join photos p on p.id = f.photo_id where p.event_id = '<event uuid>') to 'faces.csv' csv header"
  ```
  Sul VPS: `docker compose exec -T postgres psql -U rephoto -d rephoto -c "\copy (...) to stdout csv header" > faces.csv`.

## 4. Valutare

```sh
python scripts/eval/evaluate.py --labels labels.csv --manifest manifest.csv --subjects subjects.csv \
  --galleries galleries.csv --hits match-hits.csv --faces faces.csv --synth-meta synth/synth_meta.csv \
  --min-cosine 0.50 --sure-cosine 0.70 --out report/
```

`report/report.md` contiene: TP/FP/FN e precision/recall/F1 globali e per soggetto; quanti
soggetti hanno una galleria perfetta; lo split **sicuro** («Le tue foto», score ≥ 90) / **forse**;
istogrammi degli score e dei coseni veri vs falsi (testo + PNG); lo sweep di soglia 0,25–0,85 con
la soglia migliore per F1 e la più bassa con 0 FP; il recall per fascia di dimensione del volto.
Accanto: `per_subject.csv`, `pairs.csv` (ogni coppia con verdetto), `sweep.csv`.

Un esempio minimo con dati finti è in `fixtures/`:

```sh
python scripts/eval/evaluate.py --labels scripts/eval/fixtures/labels.csv \
  --manifest scripts/eval/fixtures/manifest.csv --subjects scripts/eval/fixtures/subjects.csv \
  --galleries scripts/eval/fixtures/galleries.csv --hits scripts/eval/fixtures/match-hits.csv \
  --faces scripts/eval/fixtures/faces.csv --out /tmp/report
```

## 5. Ordine consigliato (fase D di `docs/test-readiness.md` § 7)

1. Ingest di un set reale (5–10k foto bastano) e `status.sh` per il throughput.
2. **Null-selfie test** (`null-selfie.md`) ⇒ scelta di `MIN`/`SURE`.
3. 20 volontari × selfie (fotocamera e file) + etichette su 300–500 foto ⇒ `evaluate.py`.
4. Foto caricate *dopo* i selfie ⇒ verifica dell'`attach` (le coppie con `source = attach` sono nel `pairs.csv`).
5. Ripetere con `FACE_DET_SIZE` 640 vs 1024 e `LIVENESS_CHECK` on/off, confrontando i `report.md`.
