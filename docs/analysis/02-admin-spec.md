# RePhoto — Specifica del back-office admin (console di amministrazione)

> **Scopo.** Spec di prodotto/design esaustiva della **console admin** di RePhoto: menu completo, ogni schermata,
> ogni funzione, stati ed errori, regole di conferma, e soprattutto **cosa deve fare in più** rispetto al prototipo v1.
> Non è design visivo (colori/componenti li decide il design system); è *cosa esiste, chi lo usa, con quali dati, quali
> azioni, quali guardie e quali endpoint lo sostengono*.
>
> **Fonti di verità (lette per fondare questa spec):**
> [`CONTRACTS.md`](../../CONTRACTS.md) (data model, rotte HTTP, ruoli, job, retention, consensi, `audit_log`, invites,
> `event_participants`, `event_photographers`), [`docs/ux-flows.md`](../ux-flows.md) (§5 flusso admin, §9 gap API),
> e il prototipo v1 in `design/pages/admin/*.html` (login, dashboard, eventi, fotografi, partecipanti, foto, retention, audit).
>
> **Convenzione.** Etichette rivolte all'utente in **italiano**; note strutturali, nomi tabelle/rotte/campi in inglese.
> Dove un endpoint non esiste oggi è marcato **NEW** e specificato in §5. Dove la spec e questo documento divergono,
> **vince `CONTRACTS.md`**: qui si propongono estensioni *additive*, mai rinominando campi/rotte/colonne congelati.

---

## 0. Contesto reale che guida i requisiti (perché la console v1 non basta)

European Youth & Families Conference, elementi che cambiano i requisiti rispetto al prototipo a «1 conferenza / 4 admin pari»:

| Fatto reale | Conseguenza sulla console admin |
| --- | --- |
| **4000+ partecipanti**, ~3000 posti, 15+ paesi | Liste grandi, import a blocchi, ricerca/paginazione server-side ovunque; dashboard per capienza/iscrizioni |
| **Famiglie + giovani, minori 14+** con moduli di consenso | **Dashboard consenso minori + consenso parentale**: dato biometrico Art. 9 su minore → il selfie va bloccato finché il genitore non ha firmato. Oggi *non esiste nessun campo età né consenso parentale* |
| **Multilingue RO / IT / EN** | Ogni contenuto rivolto all'utente (email, informative, CMS, label evento) ha 3 lingue; serve una gestione traduzioni |
| **Registrazione per gruppi via capogruppo (group leader)** | Entità «gruppo» e «capogruppo» assenti dal modello: nuova gestione iscrizioni per gruppi, quote, allowlist derivata |
| **Alloggio / pasti / agenda / ospiti / edizioni 2019–2025** | Non è solo una gallery: la console deve pilotare la **vetrina/CMS** del sito (home, agenda, speaker, alloggio & prezzi, FAQ, edizioni, organizzatori) |
| **Nessuna gallery precedente** | Prima installazione: serve onboarding evento completo da UI (oggi gli eventi nascono solo da seed/SQL) |
| **4 admin con pari poteri** | Con CMS + GDPR minori + analytics il «tutti possono tutto» diventa rischioso → §1 propone tiers e scoping |

Queste esigenze sono il motore della sezione **§4 «Cosa deve fare in più»**.

---

## 1. Modello dei ruoli

### 1.1 Stato attuale (v1)

- `users.role ∈ {participant, photographer, admin}` con `unique(email, role)` (`CONTRACTS.md` → Postgres).
- **4 admin con capacità identiche.** Nessun permesso granulare; la sola tracciabilità è `audit_log.actor_id`
  (ux-flows §0, §5.4). Nessun lock applicativo tra admin.
- Non esiste colonna di sotto-ruolo admin, né tabella di scoping admin per evento (esiste `event_photographers`
  per i fotografi, non l'equivalente per admin).

### 1.2 Problema

Con la console estesa (CMS pubblico, cancellazioni GDPR, consenso minori, eliminazione foto irreversibile, analytics)
«tutti fanno tutto» significa che un errore di un collaboratore CMS può cancellare foto o partecipanti. Inoltre
un partner esterno (es. agenzia che cura la vetrina, o un referente di un paese) potrebbe dover toccare **solo** i
contenuti del sito o **solo** un evento, non il resto.

### 1.3 Raccomandazione: 4 tier + scoping per evento (additivo, retro-compatibile)

Mantenere `users.role = 'admin'` come oggi (nessuna rottura di contratto) e introdurre un **livello di capacità**
e uno **scope** tramite una nuova tabella `admin_grants` (NEW, §5). Un admin senza alcun grant esplicito resta
`super_admin` globale (compatibilità con i 4 admin attuali via seed/migration dei grant).

| Tier (it: etichetta) | Chi | Può | Non può |
| --- | --- | --- | --- |
| **Super-admin** (`Amministratore`) | i 4 attuali | Tutto: eventi, ruoli admin, impostazioni, chiavi, retention, GDPR, CMS, eliminazioni | — |
| **Editor** (`Editor contenuti`) | chi cura la vetrina | CMS (contenuti sito, traduzioni, agenda, ospiti, alloggio, FAQ, edizioni), anteprima/pubblica | Eliminare foto/partecipanti, retention, impostazioni di sistema, gestione admin |
| **Moderatore** (`Moderatore`) | staff foto/GDPR | Moderazione foto (incl. eliminazione con doppia conferma), code GDPR (accesso/erasure), consensi, fotografi, partecipanti | CMS, creare eventi, impostazioni, gestire admin, chiavi |
| **Visualizzatore** (`Sola lettura`) | board/revisori/partner | Vede dashboard, analytics, liste, audit; esporta | Qualsiasi azione con effetti collaterali |

**Scoping per evento.** `admin_grants(user_id, tier, event_id NULL)`: `event_id = NULL` ⇒ grant globale;
valorizzato ⇒ il tier vale solo per quell'evento. Esempi: un editor può essere limitato alla sola «Conferenza 2026»;
un moderatore nazionale può vedere solo l'evento del suo paese. Le sezioni di sistema (Impostazioni, Gestione admin)
sono sempre **globali** e riservate al super-admin.

**Permission matrix (riassunto per sezione di menu):**

| Sezione | Super-admin | Editor | Moderatore | Visualizzatore |
| --- | --- | --- | --- | --- |
| Dashboard | RW | R | R | R |
| Eventi — crea/elimina | RW | — | — | — |
| Eventi — modifica (accesso, retention, lingue, branding) | RW | — | R | R |
| Contenuti sito / CMS | RW | RW | — | R |
| Iscrizioni / Partecipanti | RW | — | RW | R |
| Fotografi | RW | — | RW | R |
| Foto (moderazione, bulk, elimina) | RW | — | RW | R |
| Gallerie & Match (soglie, reindex) | RW | — | RW | R |
| GDPR & Consensi (incl. minori, erasure) | RW | — | RW | R |
| Notifiche / Email (template, invio) | RW | RW (solo template CMS) | — | R |
| Analytics | RW | R | R | R |
| Audit log | R (tutti) | R (proprio scope) | R (proprio scope) | R (proprio scope) |
| Impostazioni (dominio, chiavi, SES, policy) | RW | — | — | — |
| Gestione admin (invita/revoca admin, tier) | RW | — | — | — |

> *R = legge, RW = legge e agisce, — = sezione nascosta.* Enforcement: lato API ogni rotta `/v1/admin/*` deve
> verificare tier+scope (oggi verifica solo `role = admin`). È un cambio **additivo** sul middleware admin, non sul
> contratto dei dati.

### 1.4 Concorrenza multi-admin

Pari poteri → nessun lock. Da gestire in UI (coerente con ux-flows §5.4):

- **Idempotenza già garantita** per import partecipanti (upsert) e retention (`dedupe_key retention:{eventId}`).
- **Optimistic concurrency** sulle risorse editabili (evento, contenuto CMS): ogni `PATCH` porta un `updatedAt`/`version`;
  se cambiato nel frattempo → `409` e banner «Questo contenuto è stato modificato da `{autore}` alle `{ora}`. Ricarica.»
  (richiede `updated_at`/`updated_by` sulle righe editabili — NEW).
- **Presence leggera**: badge «`{autore}` sta modificando» su evento/pagina CMS aperta (poll o heartbeat soft; non un lock).
- **Attività recente in dashboard** da `audit_log` (già nel prototipo) per vedere chi ha fatto l'ultima azione.
- Azioni distruttive (elimina foto, elimina partecipante, retention) sempre dietro conferma esplicita con nome risorsa.

---

## 2. Albero di navigazione completo (left-nav)

Oggi (v1) la nav ha 7 voci piatte: Dashboard, Eventi, Fotografi, Partecipanti, Foto, Retention, Audit, più un
**context switcher evento** nell'header. La console estesa diventa troppo ricca per 7 voci piatte → **nav a gruppi**.
Lo *switcher evento* resta in testa perché la maggior parte delle sezioni è event-scoped.

Legenda: **(v1)** = già nel prototipo · **(NEW)** = da aggiungere · icona = idea d'icona (stile line, coerente col set v1).

```
RePhoto admin
│  [▼ Selettore evento]  ← header, resta su tutte le sezioni event-scoped
│
├─ Panoramica
│   ├─ Dashboard ...................... (v1)   icona: grid 2×2
│   └─ Analitiche ..................... (NEW)   icona: line-chart
│
├─ Evento
│   ├─ Eventi (elenco) ............... (v1*)   icona: calendar
│   │    ├─ Nuovo evento .............. (NEW)   icona: calendar-plus
│   │    └─ Dettaglio evento → tab:
│   │         • Generale (nome, slug, date, stato)
│   │         • Accesso (open | list)  (v1 PATCH)
│   │         • Retention (giorni)     (v1 PATCH)
│   │         • Lingue (RO/IT/EN)      (NEW)
│   │         • Branding (logo, colori, cover)  (NEW)
│   ├─ Iscrizioni & Partecipanti ..... (v1*)   icona: users
│   │    ├─ Elenco / ricerca .......... (NEW read)
│   │    ├─ Import allowlist .......... (v1)
│   │    ├─ Gruppi & capogruppo ....... (NEW)   icona: user-group
│   │    └─ Minori / flag età ......... (NEW)   icona: shield-user
│   └─ Fotografi ..................... (v1*)   icona: camera
│        ├─ Elenco / stato invito .... (NEW read)
│        ├─ Invita fotografo ......... (v1)
│        ├─ Assegnazioni (giorni/zone/palchi)  (NEW)  icona: map-pin
│        └─ Copertura (coverage) ..... (NEW)   icona: target
│
├─ Media
│   ├─ Foto (moderazione) ........... (v1)   icona: image
│   │    ├─ Ricerca & filtri ......... (v1 base, NEW server)
│   │    ├─ Azioni bulk .............. (NEW)   icona: check-square
│   │    └─ Salute pipeline .......... (NEW)   icona: activity
│   └─ Gallerie & Match ............. (NEW)   icona: scan-face
│        ├─ Metriche match
│        ├─ Soglie (threshold) 0.8/0.9
│        └─ Reindex / ricostruzione
│
├─ Contenuti sito / CMS ............. (NEW, intero gruppo)   icona: layout
│   ├─ Home / sezioni ............... icona: layout-top
│   ├─ Tema & aspetto ............... icona: palette
│   ├─ Giornate / Agenda ............ icona: calendar-days
│   ├─ Ospiti / Speaker ............. icona: mic
│   ├─ Alloggio & Prezzi ............ icona: bed
│   ├─ FAQ .......................... icona: help-circle
│   ├─ Edizioni precedenti .......... icona: archive
│   ├─ Organizzatori ................ icona: building
│   ├─ Traduzioni RO/IT/EN .......... icona: languages
│   └─ Newsletter ................... icona: mail-plus
│
├─ Conformità
│   ├─ GDPR & Consensi .............. (NEW)   icona: shield-check
│   │    ├─ Consensi (elenco/stato)
│   │    ├─ Minori & consenso parentale
│   │    ├─ Richieste (accesso / erasure)
│   │    ├─ Esecuzioni retention ...... (v1 «Retention» qui dentro)
│   │    └─ DPIA (link al documento)
│   └─ Audit log .................... (v1*)   icona: clipboard-list
│
└─ Sistema
    ├─ Notifiche / Email ............ (NEW)   icona: send
    │    ├─ Template (RO/IT/EN)
    │    ├─ Invii & coda
    │    └─ Throttle / limiti
    ├─ Impostazioni ................. (NEW)   icona: settings
    │    ├─ Dominio & origini
    │    ├─ Lingue di default
    │    ├─ Policy (consenso, upload, selfie/ora)
    │    ├─ Chiavi & integrazioni (S3/MinIO, SES/SMTP, face-engine)
    │    └─ Salute sistema (health, worker, coda, face-service)
    └─ Gestione admin ............... (NEW)   icona: user-cog
         ├─ Elenco admin & tier
         └─ Invita / revoca admin

Footer nav: utente corrente (email + tier) · Lingua interfaccia · Esci
```

`*` = la voce esiste nel prototipo ma le sue viste di sola lettura (elenchi) poggiano su endpoint mancanti (ux-flows §9.2).

---

## 3. Spec per-schermata

Per ogni schermata: **Scopo · Dati mostrati · Azioni/funzioni · Stati (vuoto/caricamento/errore) · Guardie azioni distruttive**.
Note di stato: `(v1)` presente nel prototipo, `(NEW)` da aggiungere.

### 3.0 Login / Area staff  (v1)

- **Scopo.** Accesso staff senza password (magic link `role: admin`).
- **Dati.** Campo email di lavoro.
- **Azioni.** «Inviami il link di accesso» → `POST /v1/auth/request-link { email, role:"admin" }` (sempre `202`).
  Il link porta a `/verifica`→`/verify` (bottone «Entra», POST su click, anti-scanner). Sessione 30 giorni.
- **Stati.** *Caricamento*: bottone in spinner, disabilitato. *Inviato*: «Se l'indirizzo è abilitato, riceverai un link.»
  (nessuna enumerazione). *Errore rete*: banner con retry. *Rate limit* (`429`, 3/email/h · 20/IP/h): «Troppi tentativi,
  riprova tra un'ora.»
- **Guardie.** Nessuna azione distruttiva. La mail parte **solo se l'utente admin esiste** (oggi via seed).
  → vedi §4 «Bootstrap/invito admin».

### 3.1 Dashboard  (v1)

- **Scopo.** Stato live dell'evento selezionato (e aggregato) a colpo d'occhio.
- **Dati** da `GET /v1/admin/metrics`: `events, photos, faces, users, jobsQueued, jobsRunning, jobsError,
  photosByStatus{uploaded,processing,indexed,error}, galleries, originalsPending`. Prototipo mostra 5 KPI
  (Partecipanti, Foto, Gallerie, Job in coda, Job in errore), barra «Foto per stato» + legenda, «Attività recente».
- **Azioni/funzioni.**
  - KPI cliccabili → deep-link alla sezione filtrata (es. «Job in errore» → Foto filtro *Errore*; «Gallerie» → Gallerie & Match).
  - «Attività recente» da `audit_log` (NEW read) con link alla risorsa.
  - (NEW) Riga **salute**: worker vivo, profondità coda, `originalsPending`, face-service `/health`, ultimo errore job.
  - (NEW) **Scope**: KPI per evento selezionato *oppure* «Tutti gli eventi» (metrics oggi è globale → serve `?eventId=`).
  - (NEW) Durante la conferenza: mini-trend upload/h e match/h (da Analytics).
- **Stati.** *Caricamento*: skeleton dei KPI. *Vuoto* (evento appena creato): «Nessun dato ancora. Invita i fotografi
  per iniziare.» *Errore*: banner «Metriche non disponibili» + retry; i KPI mostrano `—`.
- **Guardie.** Nessuna azione distruttiva.

### 3.2 Analitiche  (NEW)

- **Scopo.** Capire come va l'evento: ricerche, match, download, funnel, per giorno/fotografo.
- **Dati.** Serie storiche: selfie inviati, match riusciti / a vuoto, foto indicizzate/h, download (singoli+ZIP),
  gallerie create, notifiche inviate; funnel partecipante (email → verify → consenso → selfie → galleria `ready` → download);
  ripartizione per **giorno** e per **fotografo** (volume caricato, % in errore, copertura).
- **Azioni.** Intervallo date; raggruppa per giorno/fotografo/zona; **esporta CSV**; toggle per evento.
- **Stati.** *Vuoto*: «Dati insufficienti per questo periodo.» *Caricamento*: skeleton grafici. *Errore*: retry.
- **Guardie.** Sola lettura. (Richiede endpoint/tabelle analytics — NEW §5; fonti: `audit_log`, `jobs`, `gallery_items.source`.)

### 3.3 Eventi — elenco  (v1*, elenco = NEW)

- **Scopo.** Vedere/gestire tutti gli eventi; punto d'ingresso a creazione e dettaglio.
- **Dati** (per riga): nome, slug, date, stato (bozza/attivo/archiviato — NEW), accesso (open|list), retention (gg),
  #foto, #partecipanti, #fotografi, lingue. Prototipo: nome, slug, accesso, retention, foto.
- **Azioni.** «Nuovo evento» (NEW create); modifica inline accesso (segmented open|list → `PATCH /v1/admin/events/:id`);
  apri dettaglio; (NEW) duplica evento (pre-compila da edizione precedente); (NEW) archivia.
- **Stati.** *Vuoto* (prima installazione, realistico qui — nessuna gallery pregressa): empty-state con CTA «Crea il primo evento».
  *Caricamento*: skeleton tabella. *Errore*: retry. Banner v1 segnala il gap API finché list/create non esistono.
- **Guardie.** Cambio `access` è immediato ma reversibile (toast «Accesso aggiornato», audit). Archivia/elimina evento:
  conferma con nome evento; **eliminare un evento con foto va vietato** finché non è vuoto (prima retention) → messaggio esplicito.

### 3.4 Evento — dettaglio (tab)  (parz. v1)

Tab del dettaglio evento:

- **Generale (NEW):** nome, slug (immutabile dopo creazione: compare nei link `/e/{slug}`), date inizio/fine,
  descrizione breve, stato (bozza/attivo/archiviato). *Guardia:* cambiare lo slug rompe i QR già stampati → bloccato/avviso forte.
- **Accesso (v1):** segmented **Aperto | Lista** → `PATCH .../events/:id { access }`. Nota contestuale: in «Lista» solo
  le email in `event_participants` possono fare il selfie; mostra link a Partecipanti.
- **Retention (v1):** `retentionDays` (int > 0) → `PATCH .../events/:id { retentionDays }`. Avviso: ridurre la retention
  **anticipa la cancellazione** delle foto oltre la nuova soglia alla prossima run → doppia conferma se riduci.
- **Lingue (NEW):** lingue attive RO/IT/EN e lingua di default; guida quali contenuti/email devono essere tradotti.
- **Branding (NEW):** logo, colore d'accento, cover, nome visualizzato per la landing `/e/{slug}` e le email dell'evento.
- **Stati.** Salvataggio ottimistico con rollback su errore; `409` se modificato da altro admin (vedi §1.4).

### 3.5 Iscrizioni & Partecipanti  (v1 import; elenco/gruppi/minori = NEW)

- **Scopo.** Gestire chi può accedere (allowlist per `access=list`), vedere gli iscritti, gestire gruppi e minori.
- **Dati.** Elenco partecipanti (email, aggiunto il, stato iscritto/in-lista, gruppo, flag minore, consenso) — oggi
  **nessun endpoint di lettura** (ux-flows §9.2). Import textarea (max 5000/chiamata, upsert idempotente) (v1).
- **Azioni.**
  - **Import allowlist** (v1): incolla email (1/riga) → `POST /v1/admin/participants/import { eventId, emails[] }`.
    Contatore live + guardia oltre 5000 (v1).
  - (NEW) **Elenco/ricerca/paginazione** server-side; filtri: stato, gruppo, minore sì/no, consenso mancante.
  - (NEW) **Rimuovi** singolo → `DELETE /v1/admin/participants/:id` (già esiste; oggi senza lista a monte).
  - (NEW) **Gruppi & capogruppo**: creare gruppi, assegnare un capogruppo (email), quota posti, importare la lista del
    gruppo in blocco (eredita allowlist dell'evento). Vista per gruppo con conteggi.
  - (NEW) **Esporta** la lista (CSV) per riconciliazione con l'anagrafica esterna.
- **Stati.** *Vuoto (open)*: banner «Evento aperto: la lista non è necessaria.» *Vuoto (list)*: CTA import. *Import in corso*:
  progress; *Import ok*: toast «N importati (M già presenti)». *Errore*: righe non valide evidenziate.
- **Guardie.** `DELETE partecipante` cancella utente/gallerie/consensi/sessioni **ma non le foto di gruppo** (scelta di
  contratto) → testo esplicito nel modal (v1 lo fa). Doppia conferma con email del partecipante.

### 3.6 Fotografi  (v1 invito; elenco/assegnazioni/coverage = NEW)

- **Scopo.** Far entrare i fotografi, assegnarli alla copertura dell'evento, monitorarli, revocarli.
- **Dati.** Elenco (email, eventi assegnati, stato invito *attivo/inviato/scaduto*, #caricate) — prototipo mostra la
  tabella ma **l'elenco non ha endpoint** (solo invito). Da `event_photographers` + `invites`.
- **Azioni.**
  - **Invita** (v1): email + evento → `POST /v1/admin/photographers/invite { email, eventId }` (invito 7 gg, email `/invito`).
  - (NEW) **Elenco/stato invito**: pending/accettato/scaduto; **rinvia invito**; **revoca** (rimuove da `event_photographers`).
  - (NEW) **Assegnazioni**: assegnare un fotografo a **giorni / zone / palchi (stage)** per pianificare la copertura
    (nuova tabella `photographer_assignments` — §5). Serve con 15+ paesi e agenda multi-sala.
  - (NEW) **Copertura (coverage)**: vista che incrocia agenda×zone con chi è assegnato e quante foto sono arrivate per
    zona/ora → evidenzia buchi di copertura durante la conferenza.
  - (NEW) **Monitor**: per fotografo, upload/h, % errori, sessioni aperte, `originalsPending`.
- **Stati.** *Vuoto*: CTA «Invita il primo fotografo». *Invito inviato*: badge; *scaduto*: azione «Rinvia». *Errore invio*: retry.
- **Guardie.** **Revoca** = conferma; le foto già caricate **restano** nell'evento e nelle gallerie (v1 lo dice). Nessuna perdita dati.

### 3.7 Foto (moderazione)  (v1 base)

- **Scopo.** Trovare, ispezionare, moderare ed eliminare foto; sorvegliare la pipeline.
- **Dati.** Griglia thumbnail con badge stato (`uploaded/processing/indexed/error`) e motivo errore (es. `sha256 mismatch`);
  filtro per stato + ricerca per ID (oggi client-side su dati statici: **manca endpoint browse** ux-flows §9.2).
- **Azioni.**
  - Filtro stato (v1), ricerca per ID foto (v1); (NEW) filtri server-side: per fotografo, giorno, `original_status`
    (solo-web/pending), con/ senza volti, intervallo date, soglia volti.
  - **Elimina singola** (v1): `DELETE /v1/admin/photos/:id` (rimuove S3 + derivati + faces + face vectors + gallery items; audit `photo.deleted`).
  - (NEW) **Azioni bulk** su selezione: elimina multipla, re-enqueue `derive`/`index`/`verify` per foto in errore,
    marca/escludi dalle gallerie. Serve con 150k foto e code in errore.
  - (NEW) **Dettaglio foto**: anteprima web, box dei volti rilevati, fotografo, hash, dimensioni, `original_status`,
    stato job e `photos.error`, in quali gallerie compare.
  - (NEW) **Salute pipeline**: pannello con code per tipo job, tasso errore, ultimi errori, retry; «Riprova tutti gli errori».
- **Stati.** *Vuoto/nessun risultato*: «Nessuna foto per questo filtro.» (v1). *Caricamento*: skeleton griglia / infinite scroll.
  *Errore*: banner + retry.
- **Guardie.** Eliminazione **irreversibile** (S3 + collezione riconoscimento) → modal con doppia conferma (v1).
  Bulk-delete: conferma che riporta **il conteggio** e richiede digitare il numero o spuntare «Capisco che è irreversibile».

### 3.8 Gallerie & Match  (NEW)

- **Scopo.** Capire e governare la qualità del riconoscimento, senza toccare il codice.
- **Dati.** #gallerie, #item per `source` (match/attach), distribuzione score, match a vuoto, gallerie senza notifica,
  soglie correnti (`DEFAULT_MATCH_THRESHOLD` 0.8, boundary UI 0.9; con InsightFace `INSIGHTFACE_MIN_COSINE`/`SURE_COSINE`).
- **Azioni.**
  - (NEW) **Reindex** evento o foto selezionate (re-enqueue `index`→`attach`): utile dopo un problema del face-service.
  - (NEW) **Soglie**: visualizzare (e, se consentito, proporre) le soglie di match. *Nota contratto:* le soglie sono
    **congelate** via env (`DEFAULT_MATCH_THRESHOLD`, cosine mapping); cambiarle a runtime è un'estensione delicata →
    in prima battuta **sola lettura** con spiegazione, modifica solo via Impostazioni/deploy.
  - (NEW) Ispezione: dato un selfie di test o una foto, mostrare i top match e gli score (strumento di diagnosi, event-scoped).
- **Stati.** *Vuoto*: «Nessuna galleria ancora.» *Reindex in corso*: banner con avanzamento coda. *Errore*: retry.
- **Guardie.** Reindex è pesante → conferma con stima (#foto). Non elimina dati; ricostruisce.

### 3.9 Contenuti sito / CMS  (NEW — intero gruppo)

Governa la **vetrina** pubblica dell'evento. Ogni contenuto è **multilingue RO/IT/EN** e ha stato *bozza/pubblicato*
con **anteprima**. Modello dati nuovo (`site_pages`, `content_blocks`, `translations` — §5), versionato e auditato.

| Sotto-schermata | Scopo | Dati | Azioni | Stati/guardie |
| --- | --- | --- | --- | --- |
| **Home / sezioni** | Comporre la home | sezioni ordinabili (hero, countdown, CTA iscrizione, highlights) | aggiungi/riordina/mostra-nascondi blocco, modifica testo/immagini, **anteprima**, pubblica | bozza vs pubblicato; pubblica = conferma |
| **Tema & aspetto** | Identità visiva | logo, colori, font, cover, favicon | carica asset, imposta token | asset su S3; anteprima |
| **Giornate / Agenda** | Programma per giornata | giornate, slot (ora, titolo, sala, relatore) | CRUD slot, riordina, traduci | conflitti orari evidenziati |
| **Ospiti / Speaker** | Relatori/ospiti | nome, ruolo, bio (RO/IT/EN), foto, link | CRUD, riordina, pubblica | immagine obbligatoria? avviso |
| **Alloggio & Prezzi** | Sistemazioni e costi | opzioni alloggio, capienza, prezzo, pasti inclusi | CRUD, note multilingue | prezzi = campo sensibile, audit sulle modifiche |
| **FAQ** | Domande frequenti | coppie Q/A per lingua | CRUD, riordina | — |
| **Edizioni precedenti** | Archivio 2019–2025 | edizione, anno, descrizione, foto/stat | CRUD, link galleria storica | sola vetrina (no biometria storica) |
| **Organizzatori** | Chi organizza | enti/persone, loghi, contatti | CRUD | — |
| **Traduzioni RO/IT/EN** | Completezza lingue | griglia chiave × 3 lingue con stato mancante/da-rivedere | modifica inline, filtra «mancanti», esporta/importa | evidenzia lingue incomplete prima di pubblicare |
| **Newsletter** | Comunicazioni di massa | iscritti (opt-in), bozze campagne | crea bozza, **invia** (dietro conferma + throttle) | invio = permesso esplicito (§Sistema/Email); rispetta consenso-contatto |

- **Stati comuni.** *Bozza non pubblicata*: badge «Modifiche non pubblicate» + «Anteprima». *Pubblicazione*: conferma
  con lingue incomplete elencate. *Conflitto* (altro editor): `409` + merge banner (§1.4). *Errore asset*: retry upload.
- **Guardie.** **Pubblica** è l'azione pubblica → conferma; **Newsletter invia** è irreversibile verso destinatari reali
  → doppia conferma + anteprima destinatari + rispetto opt-in e lingua.

### 3.10 GDPR & Consensi  (NEW; «Retention» v1 confluisce qui)

- **Scopo.** Un unico posto per consensi (inclusi **minori**), richieste interessati (accesso/erasure), esecuzioni di
  retention e il link alla DPIA. Dettaglio operativo in §6.
- **Sotto-schermate.**
  1. **Consensi** (NEW read): elenco `consents` per evento (utente, `text_version`, `granted_at`, `withdrawn_at`, `ip`, `user_agent`);
     filtra «senza consenso biometrico», «consenso revocato». Esporta per audit.
  2. **Minori & consenso parentale** (NEW, §6): elenco partecipanti con flag minore, stato del consenso del genitore
     (richiesto/in attesa/verificato/negato), chi ha verificato, blocco selfie finché non verificato.
  3. **Richieste interessati** (NEW): coda di richieste di **accesso** ed **erasure** (Art. 15/17). Stato
     ricevuta→in lavorazione→completata; su erasure l'azione collega a `DELETE participants/:id` (+ eventuali foto).
  4. **Esecuzioni retention** (v1): card per evento con retention (gg), «foto oltre soglia», ultima esecuzione,
     «Esegui pulizia ora» → `POST /v1/admin/retention/run { eventId }` (dedup, `202 {jobId}`). (NEW) **retention schedulata**
     visibile e storicizzata, non solo on-demand.
  5. **DPIA**: link a [`docs/DPIA.md`](../DPIA.md) e versione informativa/`CONSENT_TEXT_VERSION` corrente.
- **Dati.** Vedi sopra; «foto oltre soglia» richiede conteggio server (NEW) oggi non esposto.
- **Stati.** *Vuoto coda richieste*: «Nessuna richiesta aperta.» *Retention — nessuna foto oltre soglia*: bottone disabilitato
  con hint (v1). *Run in corso*: toast «Pulizia avviata», job tracciato. *Errore*: retry.
- **Guardie.** Retention **irreversibile** (S3 + `deleteCollection` quando l'evento resta vuoto) → conferma con nome evento (v1).
  Erasure di un minore → conferma rinforzata; registra base giuridica.

### 3.11 Audit log  (v1*, read = NEW)

- **Scopo.** Chi ha fatto cosa, quando, su cosa — per conformità e coordinamento tra admin.
- **Dati** da `audit_log` (azioni attuali: `photo.deleted`, `participant.deleted`, `selfie.submitted`; **da estendere**
  a `event.created/updated`, `photographer.invited/revoked`, `participants.imported`, `retention.run`,
  `consent.withdrawn`, `cms.published`, `admin.invited/revoked`, `dsr.*` — NEW): quando, autore (`actor_id`), azione,
  target, meta. Prototipo mostra tabella + ricerca client-side.
- **Azioni.** (NEW read + paginazione server) ricerca per autore/azione/oggetto, filtro per tipo azione e intervallo date,
  **esporta CSV**, deep-link alla risorsa.
- **Stati.** *Vuoto filtro*: «Nessuna voce corrisponde.» (v1). *Caricamento*: skeleton. *Errore*: retry.
- **Guardie.** Sola lettura; l'audit non è mai modificabile/eliminabile dalla UI.

### 3.12 Notifiche / Email  (NEW)

- **Scopo.** Controllare i template (RO/IT/EN), vedere gli invii, gestire limiti.
- **Dati.** Template dei 4 canali email (ux-flows §6): magic-link «Accedi a RePhoto», invito fotografo «Invito a caricare
  foto: {evento}», galleria `ready` «Le tue foto sono pronte», galleria `new` «Ci sono nuove foto per te»; stato invii
  (dalla coda `jobs` type `email`), errori SMTP/SES, rate/throttle.
- **Azioni.** Modifica testo template per lingua (oggetti di `ready`/`new` sono **fissati dalla spec** → sola lettura o
  avviso che il significato non cambia); invia **email di test**; (NEW) reinvia un'email fallita; visualizza coda/esiti.
- **Stati.** *Vuoto invii*: «Nessuna email inviata.» *Errore trasporto* (SMTP/SES): banner con dettaglio e retry.
- **Guardie.** Invio reale verso destinatari = permesso esplicito; test solo verso l'admin loggato. Nessun dato personale
  in querystring oltre al token monouso (vincolo CSP/privacy).

### 3.13 Impostazioni  (NEW)

- **Scopo.** Configurazione di sistema (solo super-admin).
- **Dati/azioni.** Dominio & origini (`WEB_ORIGIN`, media origins); lingue di default; policy (`CONSENT_TEXT_VERSION`,
  limiti upload 60 MiB, selfie/ora = 5, link/email/ora); **stato** integrazioni chiavi (S3/MinIO, SES/SMTP, face-engine
  `fake|rekognition|insightface`, `LIVENESS_CHECK`) in **sola lettura/diagnostica** (i segreti vivono in env, non in UI);
  **Salute sistema**: `/health`, worker vivo, profondità coda, face-service `/health`, `originalsPending`.
- **Stati.** *Integrazione non configurata*: badge rosso con istruzioni. *Degradato* (es. face-service `503`): banner globale.
- **Guardie.** I segreti **non si inseriscono né si mostrano** in UI (regola: niente credenziali in form — restano in env/deploy).
  Qualsiasi toggle di policy è auditato; cambi che toccano la biometria (es. soglie, liveness) richiedono conferma.

### 3.14 Gestione admin  (NEW)

- **Scopo.** Creare/gestire gli altri admin e i loro tier/scope (risolve il gap bootstrap, ux-flows §9.3).
- **Dati.** Elenco admin (email, tier, scope evento, ultimo accesso, stato invito).
- **Azioni.** **Invita admin** (email + tier + scope) → `POST /v1/admin/admins/invite` (NEW, analogo a photographers/invite);
  cambia tier/scope; **revoca** admin.
- **Stati.** *Un solo super-admin rimasto*: blocca la revoca dell'ultimo super-admin. *Invito inviato/scaduto*: badge, rinvia.
- **Guardie.** Non puoi ridurti/revocarti da solo l'ultimo super-admin; cambi di tier auditati (`admin.invited/updated/revoked`).

---

## 4. «Cosa deve fare in più» (funzioni assenti in v1, prioritizzate)

Priorità: **P0** = senza questo l'evento reale non è gestibile/è fuori norma · **P1** = necessario per operare bene ·
**P2** = qualità/efficienza. «API» indica il supporto backend (dettaglio metodo/path in §5).

| # | Funzione mancante | Perché serve (contesto reale) | Prio | API necessaria |
| --- | --- | --- | --- | --- |
| 1 | **Creazione evento da UI** | Nessuna gallery pregressa: l'admin deve poter creare la conferenza senza seed/SQL | **P0** | NEW `POST /v1/admin/events` |
| 2 | **Elenchi di lettura** (eventi, fotografi, partecipanti, foto, audit, consensi) | Tutte le schermate v1 di sola lettura poggiano sul vuoto (ux-flows §9.2) | **P0** | NEW `GET` list per ciascuna risorsa (paginati) |
| 3 | **Bootstrap/invito admin** | Impossibile creare i 3 admin aggiuntivi via UI; oggi solo seed (ux-flows §9.3) | **P0** | NEW `POST /v1/admin/admins/invite` + `accept-invite` ruolo admin |
| 4 | **Dashboard consenso minori + consenso parentale** | Minori 14+ con biometria Art. 9: selfie va bloccato finché il genitore non firma | **P0** | NEW tabelle età/parental-consent + gate nel `selfie`/`consent` |
| 5 | **Coda richieste GDPR (accesso/erasure) self-service** | 4000+ interessati: non sostenibile tutto via admin manuale; diritti Art. 15/17 | **P0** | NEW `POST /v1/events/:slug/data-request`, `GET/PATCH /v1/admin/dsr` + withdraw consenso |
| 6 | **CMS / vetrina multilingue** | L'admin ora gestisce il sito (home, agenda, speaker, alloggio, FAQ, edizioni, organizzatori) | **P0** | NEW `site_pages/content_blocks/translations` + CRUD `/v1/admin/cms/*` |
| 7 | **Retention schedulata + visibile** | Oggi solo automatica dietro le quinte + run manuale; serve storicizzazione e pianificazione | **P1** | NEW `GET /v1/admin/retention` (stato/stima/storia); scheduler worker |
| 8 | **Analytics** (ricerche, match, download, funnel, per giorno/fotografo) | Misurare l'evento, capire copertura e colli di bottiglia | **P1** | NEW `GET /v1/admin/analytics?…` (da audit/jobs/gallery_items) |
| 9 | **Assegnazione fotografi (giorni/zone/palchi) + coverage** | 15+ paesi, agenda multi-sala: pianificare e vedere i buchi di copertura | **P1** | NEW `photographer_assignments` + `/v1/admin/photographers/:id/assignments` |
| 10 | **Moderazione foto bulk + browse server-side + re-enqueue** | 150k foto: filtri client-side e delete singola non bastano; gestire gli errori in massa | **P1** | NEW `GET /v1/admin/photos?…`, `POST /v1/admin/photos/bulk`, `POST …/reprocess` |
| 11 | **Gestione partecipanti: elenco, gruppi, capogruppo** | Registrazione per gruppi via leader; quote; allowlist derivata | **P1** | NEW `GET participants`, `groups` CRUD, import per gruppo |
| 12 | **Branding/lingue per evento** | Landing `/e/{slug}` ed email coerenti col brand della conferenza, in RO/IT/EN | **P1** | NEW campi evento (branding, languages) + `PATCH events` esteso |
| 13 | **Gallerie & Match: metriche, reindex, soglie (read)** | Diagnosi qualità riconoscimento senza deploy | **P2** | NEW `GET /v1/admin/match/metrics`, `POST …/reindex` |
| 14 | **Template email editabili multilingue + reinvio + coda** | Comunicazioni in 3 lingue, visibilità invii, recupero falliti | **P2** | NEW `/v1/admin/email/templates`, `GET email jobs`, `POST resend` |
| 15 | **Audit esteso + export** | Oggi solo 3 azioni loggate; serve coprire eventi/CMS/admin/GDPR e leggerli | **P1** | NEW `GET /v1/admin/audit` + nuove `audit_log.action` |
| 16 | **Esportazioni (CSV)** partecipanti/audit/analytics | Riconciliazione con anagrafiche esterne, conformità | **P2** | NEW query param `?format=csv` sulle list |
| 17 | **Ruoli admin a tier + scoping** (§1) | CMS + GDPR + eliminazioni in mano a 4+ persone e partner → rischio | **P1** | NEW `admin_grants` + enforcement middleware |
| 18 | **Salute sistema/pipeline in dashboard** | Durante la conferenza serve accorgersi subito di coda/worker/face-service | **P1** | estende `GET /v1/admin/metrics` (worker/health/face-service) |

---

## 5. Mappatura API & gap (estende ux-flows §9)

### 5.1 Funzione admin → rotta esistente o NEW

| Funzione (schermata) | Metodo/Path | Stato |
| --- | --- | --- |
| Login staff | `POST /v1/auth/request-link {email, role:"admin"}` · `POST /v1/auth/verify {token}` | ✅ esiste |
| Dashboard metriche | `GET /v1/admin/metrics` | ✅ esiste (estendere con scope `?eventId=` + health) |
| Dashboard attività recente | *lettura `audit_log`* | ❌ NEW `GET /v1/admin/audit` |
| Analitiche | — | ❌ NEW `GET /v1/admin/analytics` |
| Eventi — elenco | — | ❌ NEW `GET /v1/admin/events` |
| Eventi — crea | — | ❌ NEW `POST /v1/admin/events` |
| Eventi — modifica accesso/retention | `PATCH /v1/admin/events/:id {access?, retentionDays?}` | ✅ esiste |
| Eventi — lingue/branding | — | ❌ NEW (estendere `PATCH /v1/admin/events/:id`) |
| Eventi — archivia/elimina | — | ❌ NEW `PATCH …/events/:id {status}` / `DELETE …/events/:id` (solo se vuoto) |
| Partecipanti — import | `POST /v1/admin/participants/import {eventId, emails[]}` | ✅ esiste |
| Partecipanti — elenco | — | ❌ NEW `GET /v1/admin/participants?eventId=&cursor=` |
| Partecipanti — rimuovi | `DELETE /v1/admin/participants/:id` | ✅ esiste |
| Gruppi & capogruppo | — | ❌ NEW `/v1/admin/groups` CRUD + `POST …/groups/:id/import` |
| Fotografi — invita | `POST /v1/admin/photographers/invite {email, eventId}` | ✅ esiste |
| Fotografi — elenco/stato invito | — | ❌ NEW `GET /v1/admin/photographers?eventId=` |
| Fotografi — revoca / rinvia | — | ❌ NEW `DELETE …/photographers/:id` · `POST …/invite/:id/resend` |
| Fotografi — assegnazioni/coverage | — | ❌ NEW `/v1/admin/photographers/:id/assignments` · `GET …/coverage` |
| Foto — browse/filtri | *solo delete oggi* | ❌ NEW `GET /v1/admin/photos?eventId=&status=&photographerId=&cursor=` |
| Foto — elimina singola | `DELETE /v1/admin/photos/:id` | ✅ esiste |
| Foto — bulk / reprocess | — | ❌ NEW `POST /v1/admin/photos/bulk {ids[], action}` · `POST …/photos/:id/reprocess` |
| Gallerie & Match | — | ❌ NEW `GET /v1/admin/match/metrics?eventId=` · `POST …/reindex` |
| GDPR — consensi (read) | *lettura `consents`* | ❌ NEW `GET /v1/admin/consents?eventId=` |
| GDPR — withdraw consenso | *nessuna rotta ritira un consenso* | ❌ NEW `POST /v1/events/:slug/consent/withdraw` (self-service) |
| GDPR — minori/parental | — | ❌ NEW (vedi §6) `GET/POST /v1/admin/minors` + gate |
| GDPR — richieste (DSR) | — | ❌ NEW `POST /v1/events/:slug/data-request` · `GET/PATCH /v1/admin/dsr` |
| Retention — run | `POST /v1/admin/retention/run {eventId}` | ✅ esiste |
| Retention — stato/stima/storia | — | ❌ NEW `GET /v1/admin/retention?eventId=` + scheduler |
| Audit — read/export | *tabella esiste, no read* | ❌ NEW `GET /v1/admin/audit?…&format=` |
| Notifiche/Email — template/coda/resend | — | ❌ NEW `/v1/admin/email/templates` · `GET …/email/jobs` · `POST …/email/:id/resend` |
| CMS — pagine/blocchi/traduzioni | — | ❌ NEW `/v1/admin/cms/pages`, `…/blocks`, `…/translations`, `POST …/publish` |
| Impostazioni — policy/health | *health esiste* | parz.: `GET /health` ✅; NEW `GET /v1/admin/settings` (read) |
| Gestione admin — invita/revoca/tier | — | ❌ NEW `POST /v1/admin/admins/invite` · `PATCH/DELETE /v1/admin/admins/:id` · `accept-invite` ruolo `admin` |

### 5.2 Nuovi endpoint — forma proposta (additiva, coerente con lo stile esistente)

Convenzioni: body `.strict()` (chiavi ignote → `400`), errori italiani `{error}`, paginazione keyset
`?cursor=&limit=` (default 50, max 200) con `{items, nextCursor}`, ogni azione con effetti scrive `audit_log`.

```text
# Eventi
POST   /v1/admin/events
  body { name, slug, startDate?, endDate?, access?: "open"|"list",
         retentionDays?: int>0, languages?: ("ro"|"it"|"en")[], defaultLanguage?,
         branding?: { logoKey?, accent?, coverKey? } }
  → 201 { id, slug, ... }   (audit: event.created)   slug unique → 409
GET    /v1/admin/events?cursor=&limit=
  → 200 { items: [{ id, slug, name, access, retentionDays, status, photos, participants, photographers }], nextCursor }
DELETE /v1/admin/events/:id   → 204  (409 se l'evento ha ancora foto)   (audit: event.deleted)

# Fotografi
GET    /v1/admin/photographers?eventId=&cursor=
  → 200 { items: [{ userId|inviteId, email, status: "active"|"invited"|"expired", events[], uploaded }], nextCursor }
DELETE /v1/admin/photographers/:id?eventId=   → 204  (rimuove event_photographers)  (audit: photographer.revoked)
POST   /v1/admin/photographers/:id/assignments  body { eventId, days[], zones[], stages[] }  → 200
GET    /v1/admin/photographers/coverage?eventId=  → 200 { byZone:[...], byDay:[...], gaps:[...] }

# Partecipanti & gruppi
GET    /v1/admin/participants?eventId=&q=&group=&minor=&cursor=
  → 200 { items: [{ id?, email, addedAt, status, groupId?, isMinor?, consent? }], nextCursor }
POST   /v1/admin/groups           body { eventId, name, leaderEmail, quota? }  → 201 { id }
POST   /v1/admin/groups/:id/import body { emails[1..5000] }  → 200 { inserted }

# Foto (moderazione)
GET    /v1/admin/photos?eventId=&status=&photographerId=&originalStatus=&cursor=
  → 200 { items: [{ id, thumbUrl, status, error?, photographerId, createdAt, originalStatus, faces }], nextCursor }
POST   /v1/admin/photos/bulk      body { ids[1..500], action: "delete"|"reprocess"|"exclude" }  → 200 { affected }
POST   /v1/admin/photos/:id/reprocess  body { stage?: "derive"|"index"|"verify" }  → 202 { jobId }  (re-enqueue)

# Gallerie & match
GET    /v1/admin/match/metrics?eventId=  → 200 { galleries, items, bySource, scoreBuckets, emptyMatches, thresholds }
POST   /v1/admin/match/reindex    body { eventId, photoIds? }  → 202 { enqueued }

# GDPR / consensi / minori / DSR
GET    /v1/admin/consents?eventId=&missing=&cursor=  → 200 { items:[{ userId, email, textVersion, grantedAt, withdrawnAt, ip }], nextCursor }
POST   /v1/events/:slug/consent/withdraw  (participant)  → 200  (set consents.withdrawn_at; audit: consent.withdrawn)
POST   /v1/events/:slug/data-request      (participant)  body { kind: "access"|"erasure" }  → 202 { id }
GET    /v1/admin/dsr?status=&cursor=      → 200 { items:[{ id, email, kind, status, createdAt }], nextCursor }
PATCH  /v1/admin/dsr/:id   body { status: "in_progress"|"done"|"rejected", note? }  → 200  (audit: dsr.updated)
# Minori (vedi §6)
GET    /v1/admin/minors?eventId=&state=  → 200 { items:[{ email, birthDate?, parentalState, verifiedBy?, verifiedAt? }] }
POST   /v1/admin/minors/:id/parental-consent  body { state: "verified"|"rejected", evidenceRef?, method }  → 200

# Retention
GET    /v1/admin/retention?eventId=  → 200 { items:[{ eventId, retentionDays, overThreshold, lastRunAt, nextRunAt }] }

# Audit, analytics
GET    /v1/admin/audit?actor=&action=&from=&to=&cursor=&format=json|csv  → 200 { items[], nextCursor }
GET    /v1/admin/analytics?eventId=&from=&to=&groupBy=day|photographer|zone  → 200 { series[], funnel{} }

# Email / notifiche
GET    /v1/admin/email/templates?lang=  → 200 { items }
PATCH  /v1/admin/email/templates/:key   body { lang, subject?, body }  → 200
GET    /v1/admin/email/jobs?status=&cursor=  → 200 { items[], nextCursor }  (da jobs type=email)
POST   /v1/admin/email/:id/resend   → 202 { jobId }

# CMS
GET/POST/PATCH/DELETE /v1/admin/cms/pages[/:id]
GET/POST/PATCH/DELETE /v1/admin/cms/pages/:id/blocks[/:blockId]   body include { lang, content }
POST   /v1/admin/cms/pages/:id/publish   → 200  (audit: cms.published; version bump)
GET/PATCH /v1/admin/cms/translations?missing=  (griglia chiave×lingua)

# Gestione admin
POST   /v1/admin/admins/invite   body { email, tier, eventId? }  → 201 { inviteId }  (invito ruolo admin, 7gg)
PATCH  /v1/admin/admins/:id      body { tier?, eventId? }  → 200
DELETE /v1/admin/admins/:id      → 204  (vietato sull'ultimo super-admin)
# e in auth:
POST   /v1/auth/accept-invite    estendere per role "admin" (crea user admin + session)

# Impostazioni (sola lettura; segreti restano in env)
GET    /v1/admin/settings  → 200 { webOrigin, languages, policy{consentTextVersion, uploadMaxBytes, selfiePerHour},
                                   integrations:{ faceEngine, mail, storage, livenessCheck }, health{...} }
```

### 5.3 Nuove tabelle/colonne (additive; non toccano i nomi congelati)

| Tabella/colonna NEW | Scopo |
| --- | --- |
| `admin_grants(user_id, tier text, event_id uuid null, created_at)` | Tier + scoping admin (§1) |
| `photographer_assignments(event_id, user_id, day date null, zone text null, stage text null)` | Assegnazione/coverage (§3.6) |
| `participant_groups(id, event_id, name, leader_email, quota int null)` + `event_participants.group_id` | Gruppi/capogruppo (§3.5) |
| `event_participants.birth_date` / `.is_minor` (o tabella `participant_minors`) | Età/minori (§6) |
| `parental_consents(id, event_id, participant_email, state, method, evidence_ref, verified_by, verified_at)` | Consenso parentale (§6) |
| `data_requests(id, event_id, email, kind, status, note, created_at, updated_by)` | Coda DSR (§3.10) |
| `site_pages(id, event_id, key, status)` · `content_blocks(id, page_id, type, position, content jsonb)` · `translations(key, lang, value, state)` | CMS multilingue (§3.9) |
| `email_templates(key, lang, subject, body, updated_by, updated_at)` | Template email editabili (§3.12) |
| `events.start_date/.end_date/.status/.languages/.default_language/.branding jsonb` | Generale/lingue/branding evento (§3.4) |
| `*.updated_at/.updated_by` su risorse editabili | Optimistic concurrency (§1.4) |
| Estensione `audit_log.action` | nuove azioni elencate in §3.11 |

> Tutte additive: `CONTRACTS.md` vieta rinomine di campi/rotte/colonne congelati, non l'aggiunta di nuove migrazioni
> (`006_*` …). `admin/metrics` va solo **esteso** (scope evento + health), non modificato nella forma esistente.

---

## 6. Minori & GDPR — approfondimento per l'admin

### 6.1 Perché è un requisito P0

L'evento include **giovani dai 14 anni**: il selfie produce un **template facciale**, dato biometrico di **categoria
particolare (Art. 9 GDPR)**. Per un minore il consenso dell'interessato **non basta**: serve il consenso/
autorizzazione di chi esercita la responsabilità genitoriale, con verifica ragionevole. Oggi il modello **non ha
alcun concetto di età né di consenso parentale**: `consents` registra un solo consenso per `text_version` con
`ip`/`user_agent`, e l'unico gate del selfie è «esiste una riga di consenso non revocata» (`CONTRACTS.md` → selfie `403`).
Quindi un minore oggi passerebbe esattamente come un adulto. Va chiuso prima dell'evento.

### 6.2 Flusso dato (cosa cambia nei checkpoint)

1. **Iscrizione**: in eventi con minori l'allowlist/gruppo porta la **data di nascita** (o un flag minore dal capogruppo).
   → `event_participants.birth_date`/`is_minor` (NEW).
2. **Prima del selfie**: se il partecipante è minore, il consenso biometrico **non è sufficiente**: il selfie resta
   **bloccato** (`403` «Consenso del genitore richiesto») finché non esiste un `parental_consents` in stato `verified`.
   Questo è un nuovo ramo del gate selfie, prima del controllo consenso esistente.
3. **Raccolta consenso parentale**: link/modulo al genitore (email del genitore raccolta all'iscrizione o via capogruppo),
   con `text_version`, lingua RO/IT/EN, timestamp, `ip`/`user_agent`; evidenza archiviata (`evidence_ref`).
4. **Verifica & sblocco**: un admin (Moderatore/Super-admin) verifica l'evidenza e marca `verified` (o `rejected`) →
   sblocca/mantiene bloccato il selfie. Ogni transizione è auditata.
5. **Erasure**: la cancellazione di un minore segue `DELETE participants/:id` (gallerie/consensi/sessioni) **più** la
   rimozione dell'evidenza parentale; se richiesto, anche le foto in cui compare (decisione caso per caso, auditata).

### 6.3 Schermata «Minori & consenso parentale» — cosa vede/fa l'admin

- **Elenco** partecipanti minori dell'evento con: email, età/anno (o «minore»), **stato parentale**
  (*richiesto · in attesa · verificato · negato*), chi ha verificato e quando, se il selfie è **bloccato/sbloccato**.
- **Filtri**: «in attesa di verifica», «negato», «scaduto», per gruppo.
- **Azioni**:
  - **Invia/rinvia richiesta** al genitore (email dedicata, multilingue).
  - **Verifica** consenso → `POST /v1/admin/minors/:id/parental-consent { state:"verified", method, evidenceRef }`
    (sblocca il selfie). **Rifiuta** → resta bloccato, con motivo.
  - **Apri evidenza** (documento/riferimento) in sola lettura.
  - **Blocca manualmente** un minore anche se ha già una galleria (incident).
- **Indicatori di conformità**: contatore «minori senza consenso parentale che hanno tentato il selfie» (devono essere 0
  bloccati correttamente), «consensi in scadenza».
- **Stati**: *vuoto* «Nessun minore in questo evento.»; *caricamento* skeleton; *errore* retry.
- **Guardie**: la verifica è un'azione sensibile → conferma + audit (`minor.parental_verified/rejected`); l'erasure di un
  minore ha conferma rinforzata e registra la base giuridica.

### 6.4 Cosa l'admin deve poter dimostrare (audit/DPIA)

- Che per ogni minore con galleria **esiste** un consenso parentale `verified` **precedente** al primo match.
- Chi ha verificato, quando, con quale metodo/evidenza (`parental_consents` + `audit_log`).
- Che i selfie dei minori senza consenso sono stati **bloccati** (nessun `match` job partito) — verificabile incrociando
  `audit_log selfie.submitted` con lo stato parentale.
- Che il selfie **non è conservato** (cancellato dopo il match, già garantito dal contratto) e che gli embedding vivono
  solo in `face_vectors`, cancellati con la foto/retention.
- Link alla **DPIA** ([`docs/DPIA.md`](../DPIA.md)) e alla versione dell'informativa (`CONSENT_TEXT_VERSION`) in vigore,
  con storia delle versioni.

---

## 7. Riassunto priorità (roadmap sintetica)

- **P0 (sblocca l'evento reale):** creazione evento, elenchi di lettura, bootstrap/invito admin, dashboard & gate
  **consenso minori/parentale**, coda GDPR + withdraw consenso, **CMS multilingue**.
- **P1 (operare bene):** retention schedulata/visibile, analytics, assegnazioni & coverage fotografi, moderazione foto
  bulk + browse server-side, partecipanti/gruppi/capogruppo, branding/lingue per evento, audit esteso, tier admin,
  salute pipeline in dashboard.
- **P2 (qualità/efficienza):** Gallerie & Match (reindex/soglie read), template email editabili + reinvio, esportazioni CSV.

> Finché P0 #1–#2 non esistono (ux-flows §9), gran parte della console admin resta «stato-obiettivo»: le schermate
> sono disegnabili, ma le loro viste di sola lettura e la creazione evento non hanno backend. Questa spec definisce
> esattamente quel backend additivo e lo scope funzionale che la console deve coprire per la conferenza.
