# Null-selfie test — misurare la coda degli impostori

Il test più informativo e a costo zero: selfie di persone che **non compaiono** in nessuna foto
dell'evento. Ogni hit è per definizione un falso positivo, quindi la distribuzione dei coseni che
ne esce è la *vera* distribuzione impostore del motore su **questo** corpus (illuminazione di sala,
volti piccoli, sfocature). È quella che decide `INSIGHTFACE_MIN_COSINE` e `INSIGHTFACE_SURE_COSINE`.

## Cosa serve

- Un evento con le foto già indicizzate (`photos.status = indexed` per la maggior parte; `status.sh`
  mostra il conteggio). Più vettori ci sono, più la coda è realistica: con 450k vettori il massimo
  impostore per selfie è più alto che con 5k.
- 20–50 selfie di persone **sicuramente assenti** dalle foto: colleghi di un'altra sede, foto di
  repertorio con liberatoria, i volti sintetici non vanno bene (il modello li tratta diversamente).
  Varietà: età, sesso, occhiali, barba, luce frontale/laterale, telefono diverso. Stessa qualità
  dei selfie reali (fotocamera frontale, 720–1080 px, volto ≥ 200 px).
- `scripts/eval/offline-search.py` con accesso al face-service e al database (vedi README.md qui).

## Procedura

1. Mettere i selfie in una cartella, nome file `null-<n>.jpg` (il soggetto estratto è `null`).
2. ```sh
   DATABASE_URL=postgres://… python scripts/eval/offline-search.py \
     --event <slug> --selfies null-selfies/ --face-service http://localhost:8090 \
     --top 2000 --out null-search.csv
   ```
   `--top 2000` basta: interessa la coda alta. Con `--all` si ottiene l'intera distribuzione
   (450k righe per selfie, utile una volta sola per vedere la forma).
3. Riassunto per selfie: il massimo, il p99 e quante hit superano i candidati di soglia.
   ```sh
   python - <<'EOF'
   import csv, collections
   best = collections.defaultdict(list)
   for r in csv.DictReader(open("null-search.csv")):
       if r["cosine"]: best[r["selfie"]].append(float(r["cosine"]))
   for s, v in sorted(best.items()):
       v.sort(reverse=True)
       over = {t: sum(1 for c in v if c >= t) for t in (0.45, 0.50, 0.55, 0.60)}
       print(f"{s:20s} max {v[0]:.3f}  p99 {v[min(len(v)-1, len(v)//100)]:.3f}  >=0.45:{over[0.45]} >=0.50:{over[0.50]} >=0.55:{over[0.55]} >=0.60:{over[0.60]}")
   EOF
   ```
4. Oppure, con le etichette vuote, `evaluate.py` fa l'istogramma: creare `labels.csv` con la sola
   intestazione e `subjects.csv` con `null,null@…`; tutte le righe risultano "false" e lo sweep
   mostra a quale soglia i FP vanno a zero.

## Come leggere i numeri

| Misura | Cosa dice |
| --- | --- |
| **max per selfie** | il coseno impostore più alto: la soglia `MIN` deve stare sopra il max della maggioranza dei selfie, altrimenti quel partecipante vede almeno una foto altrui in «Forse sei tu» |
| **quante hit ≥ soglia** | il numero di foto sbagliate che un partecipante *medio* riceverebbe a quella soglia |
| **frazione di selfie con almeno una hit ≥ (MIN+SURE)/2** | quanti vedrebbero una foto altrui in **«Le tue foto»** (il gruppo "sicuro"): deve essere ~0 |

Regola pratica: `MIN` = p99 della distribuzione dei *massimi per selfie* arrotondato in su di 0,02;
`SURE` tale che nessun selfie nullo superi `(MIN+SURE)/2`. Poi verificare il recall con i selfie
*veri* (volontari etichettati, `evaluate.py`): se il recall crolla, il compromesso va discusso,
non la soglia abbassata in silenzio.

## Ripetere quando cambia

- la risoluzione di rilevamento (`FACE_DET_SIZE`, `FACE_DET_LONG_EDGE`, `FACE_INDEX_SOURCE`):
  più volti piccoli indicizzati ⇒ coda impostore più alta;
- `INSIGHTFACE_MIN_FACE_QUALITY` (volti sfocati producono embedding "medi" che somigliano a tutti);
- il corpus (altra sala, altro fotografo, altra luce);
- il modello del face-service.

Conservare `null-search.csv` per ogni configurazione con il nome del run
(`null-search-det1024-q0.2.csv`): il confronto fra due code vale più di qualunque soglia teorica.
