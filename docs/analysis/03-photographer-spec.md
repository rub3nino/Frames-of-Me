# RePhoto — Portale Fotografo (spec esaustiva)

> **Stato:** spec di prodotto/UX per il *portale fotografo*. Non è design (niente colori/componenti),
> ma definisce **menu completo, ogni schermata, ogni funzione, gli stati/guardie e cosa serve all'API**.
> **Fonti di verità:** [`CONTRACTS.md`](../../CONTRACTS.md) (upload API, pipeline, object keys, schema),
> [`docs/ux-flows.md`](../ux-flows.md) §4 (flusso fotografo) e §9 (gap), prototipo v1
> [`design/pages/photographer/invito.html`](../../design/pages/photographer/invito.html) e
> [`design/pages/photographer/upload.html`](../../design/pages/photographer/upload.html).
> Dove questo documento propone qualcosa di non presente nel contratto, è marcato **[GAP]** con l'endpoint/tabella da aggiungere.
> Convenzione: **etichette in italiano**, note strutturali in inglese.

---

## 0. Contesto reale che guida i requisiti

European Youth & Families Conference — **3 giorni**, **~12 fotografi**, **~150.000 JPEG**, più palchi/zone/sessioni,
**4.000+ partecipanti (inclusi minori)**. I fotografi sono **professionisti invitati**, lavorano **da laptop** (upload massivo,
resume, parallelo); alcuni fanno **upload veloci da mobile**. Oggi il portale è in pratica *accetta invito + una sola
workspace di upload*. Deve diventare un **vero strumento professionale**.

Conseguenze dirette sul design del portale:

| Vincolo reale | Conseguenza sul portale |
| --- | --- |
| 150k file su 3 giorni, 12 fotografi | Serve **organizzazione** (giorno/sessione/palco/zona), non un'unica lista piatta |
| Più palchi/zone contemporanei | Serve **copertura/agenda**: sapere cosa è assegnato a me e se ogni slot è coperto |
| Ogni foto va a gallerie di partecipanti via face-match | Il fotografo deve capire **cosa è stato indicizzato** e **quanto sta "arrivando" ai partecipanti** |
| Minori presenti | Il fotografo deve conoscere **regole di ripresa e consenso** (anche se non gestisce il consenso biometrico) |
| Rete di sala instabile, sessioni lunghe | **Resume, cartella sorvegliata, PWA, wake-lock, coda offline** (già in v3) + **ricevuta/manifest** di cosa ho caricato |
| Pro che vogliono controllo | **Culling, embargo/release, elimina/sostituisci le mie foto, download/manifest**, non solo "butta dentro" |

**Principio guida:** il fotografo non deve mai vedere il mondo del riconoscimento facciale
(derive/index/attach/match). Per lui le foto sono *caricate e accettate* (`uploaded`/`indexed`) vs
*da ripetere* (`error`). Tutto il resto resta server-side (ux-flows §4.3).

---

## 1. Menu / Information Architecture completa

Oggi (v1): **`/invito`** + **`/upload`**. Proposta: la workspace resta il cuore, ma il portale diventa un'app a sezioni
con una **barra laterale sinistra** (desktop-first) e un **selettore evento** sempre in testa (il fotografo può essere in
più eventi — `event_photographers`). Su mobile le sezioni collassano in un menu «☰».

### 1.1 Chrome persistente (header)

| Elemento | Etichetta IT | Note strutturali |
| --- | --- | --- |
| Logo | RePhoto | link alla workspace |
| Selettore evento | «Evento attivo» (dropdown) | popolato da **[GAP] `GET /v1/photographer/events`**; se uno solo, preselezionato e non interattivo |
| Chip utente | email + iniziale | menu: «Profilo & accessi», «Aiuto», «Esci» (`POST /v1/auth/logout`) |
| Indicatore stato caricamento | «▲ 1.248 / 3.500 · 18 MB/s» | globale, sempre visibile mentre una coda è attiva |

### 1.2 Sezioni (sidebar)

| # | Sezione (IT) | Icona (idea) | Scopo in una riga | Esiste in v1? |
| --- | --- | --- | --- | --- |
| 1 | **Caricamento** | freccia-su-nuvola | La workspace: trascina, cartella sorvegliata, coda, stato per file | ✅ (`/upload`) |
| 2 | **I miei caricamenti** | lista-orologio | Storico sessioni, stato, **riprendi**; manifest/ricevuta per sessione | parziale (storico in `GET /v1/uploads`) |
| 3 | **Album / Organizzazione** | cartelle-impilate | Le mie foto per **giorno · sessione · palco · zona**, tagging, culling | ❌ **[GAP]** |
| 4 | **Copertura / Agenda** | calendario-check | Slot/zone **assegnati a me**, checklist «ogni sessione è coperta» | ❌ **[GAP]** |
| 5 | **Le mie statistiche** | grafico-barre | caricate/in elaborazione/indicizzate/errori, **match**, **download delle mie foto** | parziale (`GET /v1/uploads/summary` = solo conteggi stato) |
| 6 | **Qualità / Errori** | triangolo-allerta | Upload falliti, sha mismatch, originali dovuti, **coda di retry** | parziale (errori nel summary) |
| 7 | **Profilo & accessi** | badge-persona | A quali **eventi/giorni** posso caricare; i miei dati; esci | ❌ **[GAP]** (membership non elencabile) |
| 8 | **Notifiche** | campanella | Avvisi: originali ancora dovuti, foto in errore, slot scoperto, invito a nuovo evento | ❌ **[GAP]** |
| 9 | **Aiuto / Linee guida** | libro | Guida di ripresa + **naming** + **consenso/minori** | parziale (link «Linee guida» nell'invito) |

> Nota IA: è un'app a **pannelli dentro un guscio unico** (come `/admin`), non pagine che si rincorrono.
> Il fotografo «vive» nella sezione *Caricamento*; le altre sono consultazione/controllo e non interrompono una coda attiva.

---

## 2. La workspace di caricamento (`/upload`) — spec funzionale completa

La workspace è il cuore. Tutto ciò che segue è già nel contratto (CONTRACTS.md → *Web uploader*, *Two-stage upload*,
HTTP `uploads/*`) tranne dove marcato **[GAP]**.

### 2.1 Funzioni già contrattualizzate (v1→v3)

| Funzione | Comportamento | Riferimento contratto |
| --- | --- | --- |
| **Drag & drop file/cartelle** | trascina file o intere cartelle; picker «Scegli i file» | prototipo `upload.html`; Web uploader |
| **Cartella sorvegliata** | Chrome/Edge: scegli una cartella, «Avvia», riletta ogni **10 s**, carica da sola i nuovi file per giorni; «Pausa/Riprendi/Ferma/Rimuovi cartella»; «Riprendi `<nome>`» dopo restart | *Web uploader* → *Watched folder* |
| **Validazione locale** | **JPEG/PNG**, max **60 MiB** (originale), file vuoti rifiutati, scartati mostrati prima dell'upload | `uploads/init` 1..62.914.560; prototipo `validate()` |
| **Hashing sha256 in streaming** | `hash-wasm`, slice 4 MiB → memoria piatta anche a 60 MiB | *Web uploader* → *Render/sha256Hex* |
| **Dedupe** | locale (IndexedDB `name\|size\|lastModified`) + server `(event_id, sha256)` → `409` «Già caricata» | *Fingerprint cache*; init `409` |
| **Parallelismo adattivo** | slot 2, si adatta **1–6** alla banda (ogni 5 s); parti sequenziali per file | *Adaptive concurrency* |
| **Resume** | `error` → «Riprova»; «Riprova tutti»; ripresa via `GET /v1/uploads/lookup` dopo perdita cache | *Resume via lookup*; prototipo `data-retry-all` |
| **Two-stage «Prima il web, poi gli originali»** | web 1600px subito (indicizzata in secondi), originale dopo; interruttore ricordato in `localStorage` | *Two-stage upload*; init `stage` union |
| **Lista windowed** | render solo righe visibili (migliaia di righe) | prototipo; ux-flows §4.2 |
| **Stati per file** | vedi §2.3 | prototipo badge |
| **Metriche aggregate (mono)** | `caricate / totali`, MB/s, ETA; stat-row in coda/caricamento/caricate/indicizzate/errori | prototipo `stat-row`, `aggregate` |
| **Polling summary** | `GET /v1/uploads/summary` ogni **10 s**: sessioni `{open,completed,aborted}`, foto `{uploaded,processing,indexed,error,originalsPending}` | HTTP `uploads/summary` |
| **Storico sessioni** | «Mostra storico» → `GET /v1/uploads` paginato (cursor) | HTTP `uploads` |
| **PWA + Wake Lock + beforeunload** | «Installa come app», schermo acceso mentre carica, avviso di chiusura con trasferimento attivo | *Web uploader* → *PWA* |

### 2.2 Macchina a stati di un file

```
 in coda → hashing → init → upload(parti) → [web-first: WEB INVIATA] → complete → SERVER:
                                                           uploaded → processing → indexed
 ogni step può → error (con «Riprova»)
 duplicato (409) → «Già caricata» (non è un errore)
```

Lo stato intermedio **«Web inviata»** (tra `complete` del web e invio originale) appare solo in modalità two-stage;
il pannello mostra `originalsPending` finché l'originale non arriva.

### 2.3 Stati per file (badge) — etichette e semantica

| Stato (IT) | Quando | Colore badge | Azione |
| --- | --- | --- | --- |
| «In coda» | in attesa di slot | neutro | — |
| «Hashing…» | sha256 in corso | neutro + barra | — |
| «Caricamento NN%» | PUT/parti in corso | info + barra | (pausa globale) |
| «Web inviata» | two-stage, originale dovuto | info | — (automatica) |
| «Caricata» | `complete` → `uploaded` | success | — |
| «Indicizzata» | server `indexed` | success | — |
| «Già caricata» | `409` duplicato | info (non errore) | — |
| «Errore» | init/PUT/complete falliti o `aborted` | danger | **«Riprova»** |

> Guardia UX: il fotografo **non** vede `processing`/`attach`/`match`. «Indicizzata» è il massimo stato positivo esposto;
> internamente corrisponde a `photos.status = indexed`.

### 2.4 Metriche aggregate e pannelli

- **Riga titolo:** `<caricate> / <totali> · <MB/s> · ~<ETA>` (mono).
- **Stat-row (5):** In coda · In caricamento · Caricate · Indicizzate · Errori (da `uploads/summary`).
- **[GAP]** aggiungere **«Originali dovuti»** come 6ª stat quando two-stage è attivo (`originalsPending` è già nel summary; va solo mostrato).

### 2.5 WHAT MORE — funzioni che mancano alla workspace

Ognuna con *perché* e *supporto API necessario* (dettaglio endpoint in §5).

| Funzione mancante (IT) | Perché serve a 150k foto / 12 fotografi | Supporto API/tabella |
| --- | --- | --- |
| **Assegna a album/giorno/sessione al momento dell'upload** | 150k file non si organizzano a posteriori; vanno taggati mentre entrano | **[GAP]** `albums`, `photo_albums`; estendere `uploads/init` con `albumId?` |
| **Mappatura struttura-cartelle → album** | il fotografo salva in `/Giorno2/PalcoA/`: la cartella deve diventare l'album | **[GAP]** client deriva albumId dal path relativo in cartella sorvegliata + `albums` upsert |
| **EXIF/metadati** (orario scatto, fotocamera, obiettivo) | per ordinare per orario, auto-mappare su sessione, provare autorialità | **[GAP]** worker legge EXIF → `photos.captured_at`, `photos.exif jsonb` |
| **Culling / select-reject (prima e dopo l'upload)** | i pro scartano il 50–70%; caricare tutto spreca banda e riempie le gallerie | **[GAP]** reject locale (già c'è per formato); post-upload: `DELETE /v1/photographer/photos/:id` + flag «scarto» |
| **Embargo / release pianificata** | alcune foto non devono essere visibili ai partecipanti prima di un orario (es. premiazione) | **[GAP]** `photos.embargo_until`; gallerie filtrano; `POST /v1/photographer/albums/:id/release` |
| **Policy watermark** (web vs originale) | proteggere il lavoro: la derivata web mostrata al partecipante può avere watermark, l'originale no | **[GAP]** `events.watermark_policy`; worker applica watermark alla derivata `web` |
| **Elimina/sostituisci le mie foto in blocco** | errori, scarti, richieste soggetto: oggi solo l'admin cancella | **[GAP]** `DELETE /v1/photographer/photos/:id` (solo proprie); `POST .../replace` |
| **Manifest/ricevuta di cosa ho caricato** | prova professionale di consegna; riconciliazione con l'archivio locale | **[GAP]** `GET /v1/uploads/manifest?eventId=` (CSV: filename, sha256, stato, album, orario) |
| **Coda offline / ripresa dopo disconnessione** | rete di sala; già coperto da fingerprint cache + lookup, ma va reso **visibile** (banner «offline, riprendo da solo») | esistente (*Resume via lookup*), serve solo UI |
| **Mobile «scatta e carica»** | fotografo che butta dentro pochi scatti al volo dal telefono | stessa pipeline init/parts/complete; niente cartella; vedi §3.9 |

---

## 3. Spec per schermata

Per ogni schermata: **scopo · dati · azioni · stati · guardie**.

### 3.1 `/invito` — Accetta invito (esiste)

- **Scopo:** unico ingresso per creare un fotografo. Nessuna auto-registrazione.
- **Dati:** nome evento, date, luogo (dal token lato server); il token in querystring.
- **Azioni:** «Accetta e inizia a caricare» → `POST /v1/auth/accept-invite { token }` (crea utente `photographer` se manca,
  inserisce `event_photographers`, marca `used_at`, apre sessione) → redirect `/upload`. «Chiedi un nuovo invito» (mailto staff).
- **Stati:** (1) invito valido; (2) **invito scaduto/già usato** → `400`, card alternativa con banner.
- **Guardie:** TTL invito **7 giorni**, monouso; wrong role/token → `400` generico.

### 3.2 Accessi successivi — magic link fotografo (esiste)

- **Scopo:** rientro senza password.
- **Flusso:** `/` → «Accedi come fotografo» → `POST /v1/auth/request-link { email, role: "photographer" }` → sempre `202`,
  ma la mail parte **solo se l'utente photographer esiste già** (creato dall'invito). `/verify` → bottone «Entra» → POST al click.
- **Guardie:** rate limit **3/email/ora**, **20/IP/ora** → `429`; verify per photographer inesistente → `400` generico; sessione **30 giorni**.

### 3.3 `Caricamento` (`/upload`) — workspace (esiste, da estendere)

- **Scopo:** caricare migliaia di foto velocemente, con stato chiaro e ripresa.
- **Dati:** evento attivo; lista file (windowed); summary (polling 10 s); stato cartella sorvegliata; toggle two-stage; `originalsPending`.
- **Azioni:** trascina/scegli file; avvia/pausa/riprendi/ferma cartella; «Riprova»/«Riprova tutti»; «Mostra storico»;
  **[GAP]** «Assegna a album» sul drop (dropdown album o deriva da cartella); **[GAP]** «Installa come app».
- **Stati:** vuoto (nessun file) · in corso · in pausa · completato · banner **403** «Non abilitato a caricare per questo evento» (dismissibile).
- **Guardie:**
  - `uploads/init` richiede **membership** (`event_photographers`) → `403` se non membro;
  - formato JPEG/PNG + ≤ 60 MiB **validati in locale** prima dell'upload;
  - byte non combacianti al `complete` → sessione `aborted`, `400` «Caricamento corrotto»;
  - two-stage disponibile solo se il browser sa renderizzare (`OffscreenCanvas`+`createImageBitmap`+`Worker`), altrimenti `original` silenzioso;
  - cartella sorvegliata solo Chrome/Edge (altrove riga informativa).

### 3.4 `I miei caricamenti / Sessioni` (estende lo storico)

- **Scopo:** vedere tutte le sessioni, riprendere, scaricare ricevute.
- **Dati:** `GET /v1/uploads?eventId=&cursor=&limit=` (id, objectKey, sha256, contentType, status `open|completed|aborted`, createdAt), paginato newest-first.
- **Azioni:** filtra per stato; «Riprendi» una sessione `open`/interrotta (riapre la workspace e ricarica i dovuti via dedupe/lookup);
  **[GAP]** «Scarica manifest» (`GET /v1/uploads/manifest`); **[GAP]** «Originali dovuti» → lista foto `original_status = 'pending'` da completare.
- **Stati:** Completata · Interrotta (→ `aborted` dopo 24 h housekeeping) · Aperta.
- **Guardie:** vede **solo le proprie** `upload_sessions` (`404` altrove).

### 3.5 `Album / Organizzazione` **[GAP — nuovo]**

- **Scopo:** dare struttura a 150k foto: per **giorno / sessione / palco / zona**, con tagging e culling.
- **Dati:** **[GAP]** `GET /v1/photographer/photos?eventId=&album=&status=&from=&to=&cursor=` → griglia thumbnail (thumb firmato),
  per foto: stato, album, orario scatto (EXIF), n. match (opz.); `GET /v1/photographer/albums?eventId=`.
- **Azioni:** crea album («Giorno 2 · Palco A»); assegna/sposta foto (selezione multipla); tag libero;
  marca **scarto** o **elimina** (`DELETE /v1/photographer/photos/:id`); imposta **embargo/release** sull'album; riordina.
- **Stati:** album vuoto · con foto · in embargo (release futura) · rilasciato.
- **Guardie:** azioni solo su **foto proprie** dell'evento; eliminazione irreversibile → doppia conferma;
  una foto già indicizzata eliminata rimuove `faces`/vettori e la toglie dalle gallerie (riuso logica `DELETE /v1/admin/photos/:id`).

### 3.6 `Copertura / Agenda` **[GAP — nuovo]**

- **Scopo:** sapere **cosa è assegnato a me** e garantire che **ogni sessione/zona sia coperta** (12 fotografi, più palchi).
- **Dati:** **[GAP]** `GET /v1/photographer/coverage?eventId=` → slot (giorno, palco/zona, orari, titolo), assegnazione a me, stato copertura
  (derivato: esistono foto mie in quella finestra/zona?).
- **Azioni:** segna slot «coperto»/«saltato»; apri la workspace già filtrata su quell'album; vedi slot **scoperti** (nessuna foto di nessun fotografo).
- **Stati:** Assegnato · Coperto (ho foto nel range) · Scoperto · In corso.
- **Guardie:** l'assegnazione la crea l'admin; il fotografo vede le **sue** assegnazioni + (sola lettura) i buchi globali.

### 3.7 `Le mie statistiche` **[GAP — estende summary]**

- **Scopo:** feedback professionale: quanto ho caricato, cosa è arrivato ai partecipanti, quanto viene scaricato.
- **Dati:** oggi solo `GET /v1/uploads/summary` (conteggi stato). **[GAP]** `GET /v1/photographer/stats?eventId=` →
  `{ uploaded, processing, indexed, error, originalsPending, facesIndexed, photosMatched (≥1 gallery), downloads (mie foto), duplicatesSkipped }`.
- **Azioni:** periodo (giorno/sessione); esporta CSV.
- **Stati:** nessuno/parziale (evento appena iniziato) · dati live.
- **Guardie:** aggregati **solo sulle proprie foto**; nessun dato personale dei partecipanti (solo conteggi).

### 3.8 `Qualità / Errori` **[GAP — estende errori]**

- **Scopo:** coda operativa di ciò che va sistemato.
- **Dati:** foto `error` (con `photos.error`: `sha256 mismatch`, `unsupported image`, «byte non combaciano», «connessione interrotta»);
  sessioni `aborted`; foto con `original_status = 'pending'` da troppo tempo. Serve **[GAP]** `GET /v1/photographer/photos?status=error`.
- **Azioni:** «Riprova» singola/tutte; «Reinvia originale» (per i pending); «Elimina» (scarto definitivo).
- **Stati:** nessun problema · con errori · retry in corso.
- **Guardie:** `unsupported image`/`sha256 mismatch` sono **non-retryable** lato server (il retry ha senso solo reinviando un file valido).

### 3.9 Mobile «Scatta e carica» (secondaria)

- **Scopo:** pochi scatti al volo dal telefono.
- **Dati/azioni:** picker fotocamera/galleria → stessa pipeline `init/parts/complete`; niente cartella sorvegliata; niente drag&drop.
- **Guardie:** stesse di §3.3; la massa (150k) resta desktop. (ux-flows §9 p.6: confermare se al lancio o fase 2.)

### 3.10 `Profilo & accessi` / `Notifiche` / `Aiuto` **[GAP]**

- **Profilo & accessi:** email, eventi/giorni a cui posso caricare (**[GAP]** `GET /v1/photographer/events`), esci. Nessuna password.
- **Notifiche:** originali dovuti, foto in errore, slot scoperto assegnato a me, invito a nuovo evento (**[GAP]** feed; la base è `audit_log` + stato foto).
- **Aiuto / Linee guida:** guida di ripresa, **naming** consigliato (per auto-mappare album), e **consenso/minori** (§6). Oggi è solo un link «Linee guida fotografi» nell'invito.

---

## 4. "What more photographers need" — lista prioritizzata (P0/P1/P2)

Priorità rispetto allo scenario reale (3 giorni, 150k foto, minori). Ogni voce: *perché* + *supporto API/tabella*.

### P0 — senza queste il portale non regge una conferenza vera

| Funzione | Perché | Supporto API/tabella necessario |
| --- | --- | --- |
| **Lista eventi del fotografo** | il selettore evento oggi non ha sorgente dati; con N eventi è obbligatorio | **[GAP]** `GET /v1/photographer/events` (da `event_photographers` + `events`) |
| **Browse delle proprie foto** | 150k foto non gestibili alla cieca; serve vederle, filtrarle, trovare gli errori | **[GAP]** `GET /v1/photographer/photos?eventId=&status=&album=&cursor=` |
| **Album per giorno/sessione/palco/zona + assegnazione all'upload** | organizzazione impossibile a posteriori su 150k | **[GAP]** tabelle `albums`, `photo_albums`; `uploads/init` con `albumId?` |
| **Statistiche per fotografo** | feedback minimo di lavoro: quanto è indicizzato, quanti errori | **[GAP]** `GET /v1/photographer/stats?eventId=` (estende summary) |
| **Elimina le proprie foto** | scarti/errori/richieste soggetto senza passare dall'admin | **[GAP]** `DELETE /v1/photographer/photos/:id` (guardia: solo proprie) |
| **Linee guida consenso/minori visibili** | 4.000+ partecipanti con minori: obbligo informativo (vedi §6) | contenuto statico + checkbox all'accept-invite (già c'è la riga «carico solo foto dell'evento») |

### P1 — alzano molto la qualità professionale

| Funzione | Perché | Supporto API/tabella |
| --- | --- | --- |
| **Copertura/Agenda** | con 12 fotografi e più palchi, evitare buchi è un requisito operativo | **[GAP]** `coverage_slots`, `coverage_assignments`; `GET /v1/photographer/coverage` |
| **EXIF → orario scatto** | ordinamento e auto-mappatura su sessione; autorialità | **[GAP]** worker legge EXIF → `photos.captured_at`, `photos.exif` |
| **Mappatura cartella → album** | il fotografo lavora per cartelle; deve diventare struttura | client (cartella sorvegliata) + `albums` upsert |
| **Manifest/ricevuta** | prova di consegna, riconciliazione | **[GAP]** `GET /v1/uploads/manifest?eventId=` |
| **Embargo/release pianificata** | alcune foto non visibili prima di un orario | **[GAP]** `photos.embargo_until`; filtro in gallery/attach |
| **Policy watermark (web vs originale)** | protezione del lavoro | **[GAP]** `events.watermark_policy`; worker in `derive` |
| **«Originali dovuti» come vista dedicata** | two-stage lascia originali in sospeso: vanno completati prima del retention | esistente (`originalsPending` + `lookup`), serve vista/azione |

### P2 — nice-to-have / fase 2

| Funzione | Perché | Supporto API/tabella |
| --- | --- | --- |
| **Sostituisci foto** | correggere un file sbagliato mantenendo posizione/album | **[GAP]** `POST /v1/photographer/photos/:id/replace` |
| **Tag liberi + ricerca** | ritrovare per soggetto/keyword | **[GAP]** `photo_tags` |
| **Notifiche push/feed** | avvisi proattivi (errori, slot scoperti) | **[GAP]** feed da `audit_log` + stato |
| **Mobile «scatta e carica»** | scatti al volo | pipeline esistente, UI responsive |
| **Culling avanzato (rating/flag, confronto)** | workflow da Lightroom-lite | **[GAP]** `photos.rating`, flag |

---

## 5. Mappatura API & gap (estende ux-flows §9)

### 5.1 Funzioni → route **esistenti**

| Funzione portale | Route esistente | Note |
| --- | --- | --- |
| Accetta invito | `POST /v1/auth/accept-invite { token }` | crea utente + `event_photographers` |
| Rientro | `POST /v1/auth/request-link` / `verify` | role `photographer` |
| Esci | `POST /v1/auth/logout` | 204 |
| Dati evento | `GET /v1/events/:slug` | `{ id, slug, name, retentionDays, access }` |
| Init upload (orig/web) | `POST /v1/uploads/init` | union su `stage`; `403` non membro, `409` dup, `400` > 60 MiB |
| Parti multipart | `POST /v1/uploads/:id/parts` | solo sessioni multipart |
| Complete | `POST /v1/uploads/:id/complete` | `uploaded` \| `original_received` |
| Ripresa/resolve 409 | `GET /v1/uploads/lookup?eventId=&sha256=` | `photoId, originalStatus, status` |
| Storico sessioni | `GET /v1/uploads?eventId=&cursor=` | paginato |
| Riepilogo | `GET /v1/uploads/summary?eventId=` | stati + `originalsPending` |

### 5.2 Gap — nuove route/tabelle da aggiungere (additive, non rompono il contratto)

| # | Funzione | Metodo/Path proposto | Body / query | Tabella/colonna nuova |
| --- | --- | --- | --- | --- |
| G1 | Lista eventi del fotografo | `GET /v1/photographer/events` | — | — (join `event_photographers`+`events`); risp. `[{ id, slug, name, access, days? }]` |
| G2 | Browse foto proprie | `GET /v1/photographer/photos` | `?eventId=&status=&album=&from=&to=&cursor=&limit=` | — (legge `photos` dove `photographer_id = me`); risp. `{ items:[{photoId,thumbUrl,status,albumId,capturedAt,originalReady,matches?}], nextCursor }` |
| G3 | Statistiche fotografo | `GET /v1/photographer/stats` | `?eventId=` | — (aggrega `photos`/`faces`/`gallery_items`); risp. `{ uploaded, processing, indexed, error, originalsPending, facesIndexed, photosMatched, downloads, duplicatesSkipped }` |
| G4 | Album CRUD | `POST/GET/PATCH/DELETE /v1/photographer/albums[/:id]` | `{ eventId, name, kind: day\|session\|stage\|zone\|custom, startsAt?, endsAt? }` | **`albums(id, event_id, name, slug, kind, starts_at, ends_at, created_by, created_at)`** |
| G5 | Assegna foto ad album (bulk) | `POST /v1/photographer/albums/:id/photos` | `{ photoIds: uuid[1..500] }` | **`photo_albums(photo_id, album_id, pk(photo_id,album_id))`** |
| G6 | Album all'upload | estende `POST /v1/uploads/init` | aggiunge `albumId?` opzionale ai body esistenti | usa `photo_albums` (scritto al `complete`) |
| G7 | Elimina foto propria | `DELETE /v1/photographer/photos/:id` | — | — (riusa logica admin delete; guardia `photographer_id = me`); audit `photo.deleted { self: true }` |
| G8 | Sostituisci foto | `POST /v1/photographer/photos/:id/replace` | come `uploads/init` + `photoId` | — (re-`derive`/`index`) |
| G9 | Embargo/release | `POST /v1/photographer/albums/:id/release` + `PATCH .../photos` | `{ embargoUntil: ts\|null }` | **`photos.embargo_until timestamptz null`**; gallery/attach filtrano `embargo_until <= now()` |
| G10 | Manifest/ricevuta | `GET /v1/uploads/manifest` | `?eventId=&sessionId=&format=csv` | — (da `upload_sessions`+`photos`); CSV: filename, sha256, bytes, stato, album, capturedAt |
| G11 | Copertura/Agenda | `GET /v1/photographer/coverage` + admin per creare slot | `?eventId=` | **`coverage_slots(id,event_id,day,stage,zone,starts_at,ends_at,title)`**, **`coverage_assignments(slot_id,photographer_id,status assigned\|covered\|skipped, pk(slot_id,photographer_id))`** |
| G12 | EXIF/orario scatto | worker (non HTTP) in `derive` | — | **`photos.captured_at timestamptz null`**, **`photos.exif jsonb null`** |
| G13 | Watermark policy | worker in `derive` su `web` | — | **`events.watermark_policy text default 'none' check in none\|logo\|text`** |
| G14 | Notifiche fotografo | `GET /v1/photographer/notifications` | `?eventId=` | — (derivato da `photos.error`, `originalsPending`, coverage, invites) |
| G15 | Tag liberi | `POST/DELETE /v1/photographer/photos/:id/tags` | `{ tag }` | **`photo_tags(photo_id, tag, pk(photo_id,tag))`** |

> Guardie comuni ai nuovi endpoint `/v1/photographer/*`: solo ruolo `photographer`, solo **risorse proprie**
> (`photos.photographer_id = user.id`, `upload_sessions.photographer_id = user.id`), membership `event_photographers`
> sull'evento; altrimenti `403`/`404` coerenti con le regole auth esistenti. Nessun embedding/dato biometrico esce mai
> nelle risposte (vincolo *Embeddings*): le stat sono conteggi, non facce.

### 5.3 Note di coerenza con la pipeline

- **Eliminazione foto propria (G7)** deve, come l'admin delete, chiamare `deleteFaces` con gli `external_id` della foto,
  cancellare oggetti `originals/`/`web/`/`thumbs/`, rimuovere `gallery_items`/`faces`/`face_index`/`face_vectors`, e `removeAnchors`.
  Guardia aggiuntiva consigliata: avvisare se la foto è già in gallerie di partecipanti (impatto sul partecipante).
- **Embargo (G9)** interagisce con `attach`/`match`: una foto in embargo può essere **indicizzata** ma non deve comparire in
  `gallery`/`download`/`zip` finché `embargo_until <= now()`. Scelta più semplice e sicura: filtrare in lettura (gallery/attach), non impedire l'index.
- **Album all'upload (G6)** è additivo: `albumId` opzionale, scritto in `photo_albums` al `complete`; assenza = foto senza album (back-compat v3).
- **Manifest (G10)** non scrive `audit_log` (sola lettura) e non espone altri fotografi.

---

## 6. Nota consenso / minori per i fotografi

Il fotografo **non gestisce il consenso biometrico** (è del partecipante, step selfie, Art. 9 GDPR — ux-flows §3.2/§7).
Ma **ripresa e release interagiscono** col modello di consenso/allowlist dell'evento, e con i minori. Da inserire in
**«Aiuto / Linee guida»** e da richiamare all'accept-invite.

### 6.1 Cosa il fotografo deve sapere

| Tema | Regola per il fotografo |
| --- | --- |
| **Base del sistema** | Ogni partecipante trova le proprie foto con un **selfie** + consenso biometrico esplicito. Il fotografo carica foto di gruppo/scena; il match è automatico e server-side. |
| **Minori** | Riprendere minori solo nel rispetto delle regole dell'organizzatore (liberatorie raccolte dall'evento). In dubbio, **non pubblicare**: usare **embargo** (G9) finché lo staff conferma. |
| **Accesso ristretto (`access = list`)** | Se l'evento è `list`, solo le email in `event_participants` possono cercarsi. Il fotografo non deve assumere che «chiunque» vedrà le foto: la visibilità è limitata a chi è in elenco e ha dato consenso. |
| **Selfie non conservato** | Il selfie del partecipante viene **cancellato dopo il match**; il fotografo non vi ha mai accesso. Nessun dato biometrico è nelle risposte API. |
| **Retention** | Le foto vengono cancellate automaticamente oltre `retention_days`; gli **originali dovuti** (two-stage) vanno completati prima, o si perde l'originale. |
| **Naming & scatti** | Niente dati personali nei nomi file. Naming consigliato `GiornoN/Palco/sequenza` per auto-mappare gli album (G6). |
| **Eliminazione su richiesta** | Se un soggetto contesta una foto, il fotografo può eliminarla (G7) o segnalarla allo staff (`DELETE /v1/admin/photos/:id`). L'azione è irreversibile e la toglie dalle gallerie. |
| **Watermark** | Dove l'evento lo prevede, la versione web mostrata ai partecipanti può avere watermark; l'originale (scaricabile dai soggetti) no. Il fotografo non deve applicare watermark a mano: lo fa il sistema (G13). |

### 6.2 Checkpoint nel flusso fotografo

| Punto | Obbligo |
| --- | --- |
| Accept-invite | Conferma «carico solo foto scattate per questo evento» + link Linee guida (già presente nel prototipo) |
| Upload (evento `list`) | Avviso che la visibilità è ristretta all'elenco partecipanti |
| Album/Release | Possibilità di embargo per foto sensibili/minori in attesa di conferma |
| Eliminazione | Doppia conferma; nota che l'azione impatta le gallerie dei partecipanti |

---

## 7. Riepilogo gap vs v1 (one-look)

- **v1 oggi:** `/invito` + `/upload` (una workspace). Nessuna organizzazione, nessuna vista foto, nessuna statistica propria, nessuna eliminazione propria, nessuna copertura, nessun embargo/watermark, nessun manifest, nessun elenco eventi.
- **P0 da aggiungere:** `GET photographer/events`, `GET photographer/photos`, album+assegnazione all'upload, `GET photographer/stats`, `DELETE photographer/photos/:id`, linee guida consenso/minori.
- **P1:** copertura/agenda, EXIF→orario, cartella→album, manifest, embargo, watermark, vista «originali dovuti».
- **P2:** sostituisci foto, tag+ricerca, notifiche, mobile scatta-e-carica, culling avanzato.
- **Vincolo invariato:** il fotografo non vede mai derive/index/attach/match; nessun embedding/dato biometrico nelle risposte; tutti i nuovi `/v1/photographer/*` agiscono solo su risorse proprie con membership verificata.
